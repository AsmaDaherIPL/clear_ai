/**
 * Read-side repository for tenant_lookups.
 *
 * Hot-path lookup: given (tenantSlug, lookupType, sourceValue), return
 * canonicalValue. Backed by the natural-key UNIQUE on the table.
 *
 * Caching is the registry's job; this module is plain Drizzle.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tenantLookups, type TenantLookupRow } from '../../db/schema.js';

/**
 * Returns all lookups for a tenant grouped by lookup_type.
 * Outer keys are lookup_types, inner Map maps source_value -> canonical_value.
 *
 * Use this when the renderer only needs the canonical value (currency code,
 * country code, etc.). For lookups that also carry metadata (e.g.
 * client_source_company → SourceCompanyNo + sourceCompanyName), use
 * `getLookupsBySlugWithMetadata`.
 */
export async function getLookupsBySlug(slug: string): Promise<Map<string, Map<string, string>>> {
  const rows = await db().select().from(tenantLookups).where(eq(tenantLookups.tenant, slug));
  const out = new Map<string, Map<string, string>>();
  for (const r of rows) {
    let bucket = out.get(r.lookupType);
    if (!bucket) {
      bucket = new Map<string, string>();
      out.set(r.lookupType, bucket);
    }
    bucket.set(r.sourceValue, r.canonicalValue);
  }
  return out;
}

export interface LookupValue {
  canonical: string;
  metadata: Record<string, unknown>;
}

/**
 * Same as getLookupsBySlug but preserves the per-row metadata jsonb. Used by
 * the ZATCA Declaration renderer when it needs the secondary fields
 * (sourceCompanyName, city Arabic name, etc.) attached to a lookup.
 */
export async function getLookupsBySlugWithMetadata(
  slug: string,
): Promise<Map<string, Map<string, LookupValue>>> {
  const rows = await db().select().from(tenantLookups).where(eq(tenantLookups.tenant, slug));
  const out = new Map<string, Map<string, LookupValue>>();
  for (const r of rows) {
    let bucket = out.get(r.lookupType);
    if (!bucket) {
      bucket = new Map<string, LookupValue>();
      out.set(r.lookupType, bucket);
    }
    bucket.set(r.sourceValue, {
      canonical: r.canonicalValue,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    });
  }
  return out;
}

/** Single-row read; returns the row or null. Used by admin / debug routes. */
export async function findLookup(
  slug: string,
  lookupType: string,
  sourceValue: string,
): Promise<TenantLookupRow | null> {
  const rows = await db()
    .select()
    .from(tenantLookups)
    .where(
      and(
        eq(tenantLookups.tenant, slug),
        eq(tenantLookups.lookupType, lookupType),
        eq(tenantLookups.sourceValue, sourceValue),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
