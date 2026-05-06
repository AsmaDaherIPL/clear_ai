/**
 * Operator config registry — in-memory cache of OperatorConfig keyed by slug.
 *
 * Loaded at startup; refreshable via programmatic refresh(). The rest
 * of the codebase resolves operators via `resolve(slug)` only — no other
 * module reaches into the operators table directly.
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
  type OperatorConfig,
  type TransformKind,
} from './operator-config.types.js';
import {
  getOperatorBySlug,
  getMappingsByOperatorId,
  getConstantsByOperatorId,
  listOperators,
} from './operator.repository.js';
import { MappingValidationError, OperatorNotFoundError } from './operator.errors.js';
import type { OperatorFieldMappingRow, OperatorConstantRow, OperatorRow } from '../../db/schema.js';

const CACHE = new Map<string, OperatorConfig>();

/**
 * Hydrate a single operator from DB into a OperatorConfig. Returns null when no
 * row exists; throws MappingValidationError on invalid mappings.
 */
async function loadOne(slug: string): Promise<OperatorConfig | null> {
  const operator = await getOperatorBySlug(slug);
  if (!operator) return null;
  const [mappings, constants] = await Promise.all([
    getMappingsByOperatorId(operator.id),
    getConstantsByOperatorId(operator.id),
  ]);
  return buildConfig(operator, mappings, constants);
}

function buildConfig(
  operator: OperatorRow,
  mappingRows: ReadonlyArray<OperatorFieldMappingRow>,
  constantRows: ReadonlyArray<OperatorConstantRow>,
): OperatorConfig {
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
      fallbackColumns: Object.freeze([...(m.fallbackColumns ?? [])]),
    });
  }

  for (const required of CANONICAL_REQUIRED_FIELDS) {
    if (!seenCanonical.has(required)) {
      problems.push(`required canonical field '${required}' has no mapping rule`);
    }
  }

  if (problems.length > 0) {
    throw new MappingValidationError(operator.slug, problems);
  }

  // Identity columns are required for ZATCA filing. Fail loud at registry
  // load if any are NULL — the renderer would otherwise emit empty XML
  // attributes and the filing would be rejected.
  const missingIdentity: string[] = [];
  if (!operator.tabadulUserid) missingIdentity.push('tabadul_userid');
  if (!operator.tabadulAcctId) missingIdentity.push('tabadul_acct_id');
  if (!operator.brokerLicenseType) missingIdentity.push('broker_license_type');
  if (!operator.brokerLicenseNo) missingIdentity.push('broker_license_no');
  if (!operator.brokerRepresentativeNo) missingIdentity.push('broker_representative_no');
  if (!operator.defaultSourceCompanyName) missingIdentity.push('default_source_company_name');
  if (!operator.defaultSourceCompanyNo) missingIdentity.push('default_source_company_no');
  if (missingIdentity.length > 0) {
    throw new MappingValidationError(
      operator.slug,
      missingIdentity.map((c) => `operators.${c} is NULL — required for ZATCA filing`),
    );
  }

  const constants: Record<string, string> = {};
  for (const c of constantRows) constants[c.key] = c.value;

  return Object.freeze<OperatorConfig>({
    id: operator.id,
    slug: operator.slug,
    displayName: operator.displayName,
    active: operator.active,
    mappings: Object.freeze(mappings),
    constants: Object.freeze(constants),
    identity: Object.freeze({
      tabadulUserid: operator.tabadulUserid!,
      tabadulAcctId: operator.tabadulAcctId!,
      brokerLicenseType: operator.brokerLicenseType!,
      brokerLicenseNo: operator.brokerLicenseNo!,
      brokerRepresentativeNo: operator.brokerRepresentativeNo!,
      defaultSourceCompanyName: operator.defaultSourceCompanyName!,
      defaultSourceCompanyNo: operator.defaultSourceCompanyNo!,
    }),
  });
}

/**
 * Public API — the rest of the codebase calls this and only this.
 * Throws OperatorNotFoundError when the slug is unknown.
 */
export async function resolve(slug: string): Promise<OperatorConfig> {
  const cached = CACHE.get(slug);
  if (cached) return cached;
  const fresh = await loadOne(slug);
  if (!fresh) throw new OperatorNotFoundError(slug);
  CACHE.set(slug, fresh);
  return fresh;
}

/**
 * Force a re-read from DB for one operator. Called by programmatic refresh()
 * after a seed run, and by tests that mutate the DB directly.
 */
export async function refresh(slug: string): Promise<OperatorConfig> {
  CACHE.delete(slug);
  const fresh = await loadOne(slug);
  if (!fresh) throw new OperatorNotFoundError(slug);
  CACHE.set(slug, fresh);
  return fresh;
}

/** Drop every cache entry. Used by tests; rarely needed in prod. */
export function clearCache(): void {
  CACHE.clear();
}

/**
 * Eagerly hydrate every operator. Called from server/app.ts at boot so the
 * first request doesn't pay a cold DB read. Mapping problems on any single
 * operator fail boot — fail-closed per the no-silent-fallback rule.
 */
export async function warmAll(): Promise<ReadonlyArray<OperatorConfig>> {
  const rows = await listOperators();
  const out: OperatorConfig[] = [];
  for (const t of rows) {
    const cfg = await loadOne(t.slug);
    if (!cfg) continue;
    CACHE.set(t.slug, cfg);
    out.push(cfg);
  }
  return out;
}

/** Read-only snapshot of currently cached configs. */
export function snapshot(): ReadonlyArray<OperatorConfig> {
  return [...CACHE.values()];
}
