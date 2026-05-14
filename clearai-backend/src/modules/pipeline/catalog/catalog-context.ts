/**
 * Catalog-context lookup. Given a 12-digit HS code, returns the leaf
 * Arabic / English label plus the breadcrumb path through the tariff
 * tree. Both orchestrators (legacy + anchored) call this to feed the
 * submission_description stage.
 *
 * Pure DB query. Extracted from the legacy orchestrator in PR-A-5 so
 * the anchored orchestrator doesn't need to import from legacy code.
 */
import { getPool } from '../../../db/client.js';

export interface CatalogContext {
  /** Leaf Arabic from zatca_hs_codes.description_ar. */
  leafAr: string | null;
  /** Leaf English. */
  leafEn: string | null;
  /** Breadcrumb path through the tariff tree (chapter > heading > hs6 > leaf), Arabic. */
  pathAr: string | null;
  /** Breadcrumb path, English. */
  pathEn: string | null;
}

export async function lookupCatalogContext(code: string): Promise<CatalogContext> {
  const pool = getPool();
  const r = await pool.query<{
    description_ar: string | null;
    description_en: string | null;
    path_ar: string | null;
    path_en: string | null;
  }>(
    `SELECT c.description_ar, c.description_en, d.path_ar, d.path_en
       FROM zatca_hs_codes c
       LEFT JOIN zatca_hs_code_display d ON d.code = c.code
      WHERE c.code = $1`,
    [code],
  );
  const row = r.rows[0];
  return {
    leafAr: row?.description_ar ?? null,
    leafEn: row?.description_en ?? null,
    pathAr: row?.path_ar ?? null,
    pathEn: row?.path_en ?? null,
  };
}
