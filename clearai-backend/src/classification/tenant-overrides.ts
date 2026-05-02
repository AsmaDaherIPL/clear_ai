/**
 * Tenant-override lookup. Resolves a merchant-supplied code to a tenant's
 * canonical ZATCA target via exact match, then prefix-walk down to minPrefix.
 *
 * Renamed from broker-mapping.ts in commit #2 of ADR-0025. The semantics
 * are unchanged from the caller's POV; the storage table moved from
 * broker_code_mapping to tenant_code_overrides and the lookup is now
 * tenant-scoped (today only 'naqel'; multi-tenant in the future).
 */
import { getPool } from '../db/client.js';

export interface TenantOverrideHit {
  targetCode: string;
  /** 12 = exact, < 12 = walked-up. */
  matchedLength: number;
  /** The actual stored source code that matched (may be a shorter prefix). */
  matchedSourceCode: string;
}

export interface TenantOverrideOpts {
  /** Default 6 — refuse to match on very short prefixes that would over-collide. */
  minPrefix?: number;
}

const DIGITS_ONLY = /[^\d]/g;

/** Returns null when no match at any prefix length. */
export async function lookupTenantOverride(
  rawCode: string,
  tenant: string,
  opts: TenantOverrideOpts = {},
): Promise<TenantOverrideHit | null> {
  const minPrefix = opts.minPrefix ?? 6;
  const normalised = rawCode.replace(DIGITS_ONLY, '');
  if (normalised.length < minPrefix) return null;

  const pool = getPool();

  // Try literal input then progressively shorter prefixes; longest match wins.
  const candidates: string[] = [];
  for (let len = normalised.length; len >= minPrefix; len--) {
    candidates.push(normalised.slice(0, len));
  }

  const r = await pool.query<{
    source_code_norm: string;
    target_code: string;
  }>(
    `SELECT source_code_norm, target_code
       FROM tenant_code_overrides
      WHERE tenant = $1
        AND source_code_norm = ANY($2::varchar[])
      ORDER BY length(source_code_norm) DESC
      LIMIT 1`,
    [tenant, candidates],
  );

  const row = r.rows[0];
  if (!row) return null;
  return {
    targetCode: row.target_code,
    matchedLength: row.source_code_norm.length,
    matchedSourceCode: row.source_code_norm,
  };
}
