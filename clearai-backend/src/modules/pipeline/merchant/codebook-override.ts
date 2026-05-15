/**
 * Tenant-override lookup. Resolves a merchant-supplied code to an operator's
 * canonical ZATCA target via exact match, then prefix-walk down to minPrefix.
 *
 * Moved from classify/code-resolver/codebook-override.ts in PR 13 into the
 * merchant namespace. Semantics unchanged from the caller's POV.
 */
import { getPool } from '../../../db/client.js';

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
  operator: string,
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
    source_code: string;
    target_code: string;
  }>(
    `SELECT oco.source_code, oco.target_code
       FROM operator_code_overrides oco
       JOIN operators op ON op.id = oco.operator_id
      WHERE op.slug = $1
        AND oco.source_code = ANY($2::varchar[])
      ORDER BY length(oco.source_code) DESC
      LIMIT 1`,
    [operator, candidates],
  );

  const row = r.rows[0];
  if (!row) return null;
  return {
    targetCode: row.target_code,
    matchedLength: row.source_code.length,
    matchedSourceCode: row.source_code,
  };
}
