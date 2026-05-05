/**
 * Tenant config registry — in-memory cache of TenantConfig keyed by slug.
 *
 * Loaded at startup; refreshable via POST /tenants/:slug/refresh. The rest
 * of the codebase resolves tenants via `resolve(slug)` only — no other
 * module reaches into the tenants table directly.
 *
 * Validation runs on every load:
 *   • every mapping's canonicalField is in KNOWN_CANONICAL_FIELDS
 *   • every required CanonicalLineItem field has a corresponding mapping
 *     OR a default_value
 * Validation failure throws MappingValidationError — the registry is
 * fail-closed, never serving a partially-valid config.
 */
import {
  CANONICAL_REQUIRED_FIELDS,
  KNOWN_CANONICAL_FIELDS,
  type CanonicalField,
  type ColumnMappingRule,
  type TenantConfig,
  type TransformKind,
} from './tenant-config.types.js';
import {
  getTenantBySlug,
  getMappingsBySlug,
  getConstantsBySlug,
  listTenants,
} from './tenant.repository.js';
import { MappingValidationError, TenantNotFoundError } from './tenant.errors.js';
import type { TenantFieldMappingRow, TenantConstantRow, TenantRow } from '../../db/schema.js';

const CACHE = new Map<string, TenantConfig>();

/**
 * Hydrate a single tenant from DB into a TenantConfig. Returns null when no
 * row exists; throws MappingValidationError on invalid mappings.
 */
async function loadOne(slug: string): Promise<TenantConfig | null> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return null;
  const [mappings, constants] = await Promise.all([
    getMappingsBySlug(slug),
    getConstantsBySlug(slug),
  ]);
  return buildConfig(tenant, mappings, constants);
}

function buildConfig(
  tenant: TenantRow,
  mappingRows: ReadonlyArray<TenantFieldMappingRow>,
  constantRows: ReadonlyArray<TenantConstantRow>,
): TenantConfig {
  const mappings: ColumnMappingRule[] = [];
  const problems: string[] = [];
  const seenCanonical = new Set<CanonicalField>();

  for (const m of mappingRows) {
    if (!KNOWN_CANONICAL_FIELDS.has(m.canonicalField as CanonicalField)) {
      problems.push(`unknown canonical_field '${m.canonicalField}' in mapping ${m.id}`);
      continue;
    }
    const transform = (m.transform ?? null) as TransformKind;
    if (transform !== null && transform !== 'trim' && transform !== 'uppercase' && transform !== 'lowercase') {
      problems.push(`invalid transform '${m.transform}' on mapping ${m.id}`);
      continue;
    }
    const canonicalField = m.canonicalField as CanonicalField;
    seenCanonical.add(canonicalField);
    mappings.push({
      sourceColumn: m.sourceColumn,
      canonicalField,
      required: m.required,
      transform,
      defaultValue: m.defaultValue ?? null,
    });
  }

  // Every CANONICAL_REQUIRED_FIELDS field must be reachable: either a mapping
  // exists with required=true OR (mapping with default_value) OR (mapping
  // with required=false — nullable). At minimum, the field must be mappable.
  for (const required of CANONICAL_REQUIRED_FIELDS) {
    if (!seenCanonical.has(required)) {
      problems.push(`required canonical field '${required}' has no mapping rule`);
    }
  }

  if (problems.length > 0) {
    throw new MappingValidationError(tenant.slug, problems);
  }

  const constants: Record<string, string> = {};
  for (const c of constantRows) constants[c.key] = c.value;

  return Object.freeze<TenantConfig>({
    id: tenant.id,
    slug: tenant.slug,
    displayName: tenant.displayName,
    bundleSize: tenant.bundleSize,
    hvThresholdSar: Number(tenant.hvThresholdSar),
    active: tenant.active,
    mappings: Object.freeze(mappings),
    constants: Object.freeze(constants),
  });
}

/**
 * Public API — the rest of the codebase calls this and only this.
 * Throws TenantNotFoundError when the slug is unknown.
 */
export async function resolve(slug: string): Promise<TenantConfig> {
  const cached = CACHE.get(slug);
  if (cached) return cached;
  const fresh = await loadOne(slug);
  if (!fresh) throw new TenantNotFoundError(slug);
  CACHE.set(slug, fresh);
  return fresh;
}

/**
 * Force a re-read from DB for one tenant. Called by POST /tenants/:slug/refresh
 * after a seed run, and by tests that mutate the DB directly.
 */
export async function refresh(slug: string): Promise<TenantConfig> {
  CACHE.delete(slug);
  const fresh = await loadOne(slug);
  if (!fresh) throw new TenantNotFoundError(slug);
  CACHE.set(slug, fresh);
  return fresh;
}

/** Drop every cache entry. Used by tests; rarely needed in prod. */
export function clearCache(): void {
  CACHE.clear();
}

/**
 * Eagerly hydrate every tenant. Called from server/app.ts at boot so the
 * first request doesn't pay a cold DB read. Mapping problems on any single
 * tenant fail boot — fail-closed per the no-silent-fallback rule.
 */
export async function warmAll(): Promise<ReadonlyArray<TenantConfig>> {
  const rows = await listTenants();
  const out: TenantConfig[] = [];
  for (const t of rows) {
    const cfg = await loadOne(t.slug);
    if (!cfg) continue;
    CACHE.set(t.slug, cfg);
    out.push(cfg);
  }
  return out;
}

/** Read-only snapshot of currently cached configs. Used by GET /tenants. */
export function snapshot(): ReadonlyArray<TenantConfig> {
  return [...CACHE.values()];
}
