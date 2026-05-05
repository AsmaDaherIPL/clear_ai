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
