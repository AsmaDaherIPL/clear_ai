/**
 * Read-side repository for operator_lookups + tabadul_codes.
 *
 * The two tables are merged at read time into a single Map shape so the
 * renderer doesn't need to know which is which:
 *   • tabadul_codes        — universal Tabadul reference data
 *                            (currency_code, country_of_origin, tabdul_city,
 *                            port, customs_gate, uom)
 *   • operator_lookups     — per-operator overrides / extensions
 *                            (client_country, client_source_company,
 *                            destination_station)
 *
 * If the same (type, source) appears in both tables, operator_lookups wins
 * (operator-specific override semantics).
 *
 * Caching is the registry's job; this module is plain Drizzle.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { operatorLookups, tabadulCodes, type OperatorLookupRow } from '../../db/schema.js';

export interface LookupValue {
  canonical: string;
  metadata: Record<string, unknown>;
}

/**
 * Returns all lookups available to an operator, merging tabadul_codes
 * (universal) with operator_lookups (per-operator). On collision,
 * operator_lookups overrides tabadul_codes for that key.
 */
export async function getLookupsByOperatorId(operatorId: string): Promise<Map<string, Map<string, string>>> {
  const merged = await getLookupsByOperatorIdWithMetadata(operatorId);
  const out = new Map<string, Map<string, string>>();
  for (const [type, bucket] of merged) {
    const flat = new Map<string, string>();
    for (const [src, val] of bucket) flat.set(src, val.canonical);
    out.set(type, flat);
  }
  return out;
}

/**
 * Same as getLookupsByOperatorId but preserves the per-row metadata jsonb.
 * Used by the ZATCA Declaration renderer when it needs the secondary fields
 * (sourceCompanyName, city Arabic name, etc.) attached to a lookup.
 */
export async function getLookupsByOperatorIdWithMetadata(
  operatorId: string,
): Promise<Map<string, Map<string, LookupValue>>> {
  const out = new Map<string, Map<string, LookupValue>>();

  // Universal Tabadul codes first.
  const tabadulRows = await db().select().from(tabadulCodes);
  for (const r of tabadulRows) {
    let bucket = out.get(r.codeType);
    if (!bucket) {
      bucket = new Map<string, LookupValue>();
      out.set(r.codeType, bucket);
    }
    bucket.set(r.sourceValue, {
      canonical: r.canonicalValue,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    });
  }

  // Per-operator overrides next; later writes win on collision.
  const operatorRows = await db()
    .select()
    .from(operatorLookups)
    .where(eq(operatorLookups.operatorId, operatorId));
  for (const r of operatorRows) {
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

/** Single-row read against operator_lookups; returns the row or null. */
export async function findOperatorLookup(
  operatorId: string,
  lookupType: string,
  sourceValue: string,
): Promise<OperatorLookupRow | null> {
  const rows = await db()
    .select()
    .from(operatorLookups)
    .where(
      and(
        eq(operatorLookups.operatorId, operatorId),
        eq(operatorLookups.lookupType, lookupType),
        eq(operatorLookups.sourceValue, sourceValue),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
