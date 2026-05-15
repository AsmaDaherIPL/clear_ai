/**
 * Codebook helpers for merchant resolution.
 *
 * Pure DB queries against `zatca_hs_codes`. No business logic.
 * Moved from constrain/codebook.ts in PR 13 into the merchant namespace.
 */
import { getPool } from '../../../db/client.js';

export interface HsCodeRecord {
  code: string;
  is_deleted: boolean;
  replacement_codes: string[] | null;
  description_en: string | null;
  description_ar: string | null;
}

/**
 * Lookup a single 12-digit code in the codebook. Returns null when
 * the code is absent.
 */
export async function lookupCode(code: string): Promise<HsCodeRecord | null> {
  const pool = getPool();
  const r = await pool.query<HsCodeRecord>(
    `SELECT code, is_deleted, replacement_codes, description_en, description_ar
       FROM zatca_hs_codes
      WHERE code = $1`,
    [code],
  );
  return r.rows[0] ?? null;
}

/**
 * Expand a code prefix (6-11 digits) to its active 12-digit children.
 * Returns at most `limit` rows.
 */
async function expandPrefix(prefix: string, limit: number): Promise<HsCodeRecord[]> {
  const pool = getPool();
  const r = await pool.query<HsCodeRecord>(
    `SELECT code, is_deleted, replacement_codes, description_en, description_ar
       FROM zatca_hs_codes
      WHERE code LIKE $1
        AND is_deleted = false
      ORDER BY code
      LIMIT $2`,
    [`${prefix}%`, limit],
  );
  return r.rows;
}

/**
 * Walk a code prefix down to its codebook anchor. Carriers' national
 * extensions don't always align with ZATCA's canonical padding, so a
 * full 10/11-digit prefix may return zero children even when the
 * chapter+heading exist. Walk 10 -> 8 -> 6 (HS6 is the international
 * harmonized prefix, almost always present).
 *
 * Returns `{ children: [], matched_prefix: <fullPrefix> }` when no
 * level has children — caller resolves this as `unknown`.
 */
export async function expandWithFallback(
  fullPrefix: string,
  limit = 50,
): Promise<{ children: HsCodeRecord[]; matched_prefix: string }> {
  const tried = new Set<string>();
  const candidates: string[] = [];
  if (fullPrefix.length >= 10) candidates.push(fullPrefix.slice(0, 10));
  if (fullPrefix.length >= 8) candidates.push(fullPrefix.slice(0, 8));
  if (fullPrefix.length >= 6) candidates.push(fullPrefix.slice(0, 6));
  for (const p of candidates) {
    if (tried.has(p)) continue;
    tried.add(p);
    const children = await expandPrefix(p, limit);
    if (children.length > 0) {
      return { children, matched_prefix: p };
    }
  }
  return { children: [], matched_prefix: fullPrefix };
}
