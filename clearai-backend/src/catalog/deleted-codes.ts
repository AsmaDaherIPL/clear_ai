/**
 * Lookup helpers for SABER-deleted HS codes.
 *
 * When the user submits a 12-digit code (or a parent prefix that exactly
 * matches a deleted code) via POST /classifications/expand, the expand route
 * calls `getDeletionInfo` BEFORE running retrieval.  If the code is deleted,
 * the route returns Option A: refuse + surface alternatives so the broker can
 * confirm which replacement to use.
 *
 * Descriptions for alternatives are fetched at read time with a single
 * WHERE code = ANY($1) query — the refusal path is rare enough that the
 * overhead is negligible, and denormalising descriptions would duplicate data
 * that ZATCA may update independently.
 */
import { getPool } from '../db/client.js';

export interface DeletedCodeInfo {
  deletionEffectiveDate: string; // ISO date string e.g. '2025-11-27'
  alternatives: {
    code: string;
    description_en: string | null;
    description_ar: string | null;
  }[];
}

/**
 * Returns deletion metadata + resolved alternative descriptions for `code`,
 * or null if the code is not marked deleted in hs_codes.
 *
 * @param code  12-digit ZATCA HS code (the deleted parent).
 */
export async function getDeletionInfo(code: string): Promise<DeletedCodeInfo | null> {
  const pool = getPool();

  const deletedRes = await pool.query<{
    deletion_effective_date: string;
    replacement_codes: string[] | null;
  }>(
    `SELECT deletion_effective_date, replacement_codes
       FROM zatca_hs_codes
      WHERE code = $1
        AND is_deleted = true`,
    [code],
  );

  if (deletedRes.rowCount === 0) return null;

  const row = deletedRes.rows[0]!;
  const replacementCodes: string[] = Array.isArray(row.replacement_codes)
    ? row.replacement_codes
    : [];

  if (replacementCodes.length === 0) {
    return {
      deletionEffectiveDate: row.deletion_effective_date,
      alternatives: [],
    };
  }

  // Single indexed lookup for all alternative descriptions.
  const altRes = await pool.query<{
    code: string;
    description_en: string | null;
    description_ar: string | null;
  }>(
    `SELECT code, description_en, description_ar
       FROM zatca_hs_codes
      WHERE code = ANY($1::varchar[])
      ORDER BY code`,
    [replacementCodes],
  );

  // Preserve the order from replacement_codes (SABER's listed order).
  const byCode = new Map(altRes.rows.map((r) => [r.code, r]));
  const alternatives = replacementCodes
    .map((c) => byCode.get(c))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  return {
    deletionEffectiveDate: row.deletion_effective_date,
    alternatives,
  };
}
