import { getPool } from '../../db/client.js';
import { dutyInfoFromColumns, type DutyInfo } from './duty-info.service.js';
import { lookupProcedures, type ProcedureInfo, type LookupLogger } from './procedure-codes.repository.js';

export interface CodeEnrichment {
  duty_info: DutyInfo | null;
  procedures: ProcedureInfo[];
}

/** Batch-enrich N final codes in a single round-trip + one procedures lookup. */
export async function enrichCodes(
  codes: ReadonlyArray<string | null>,
  log?: LookupLogger,
): Promise<Map<string, CodeEnrichment>> {
  const distinct = Array.from(new Set(codes.filter((c): c is string => !!c)));
  if (distinct.length === 0) return new Map();

  const pool = getPool();
  const r = await pool.query<{
    code: string;
    duty_rate_pct: string | null;
    duty_status: string | null;
    procedures: string[] | null;
  }>(
    `SELECT code, duty_rate_pct, duty_status, procedures
       FROM zatca_hs_codes
      WHERE code = ANY($1::varchar[])`,
    [distinct],
  );

  const allProcedureCodes = new Set<string>();
  for (const row of r.rows) {
    for (const p of row.procedures ?? []) allProcedureCodes.add(p);
  }
  const procedureInfo = await lookupProcedures(Array.from(allProcedureCodes), log);
  const byProcCode = new Map(procedureInfo.map((p) => [p.code, p]));

  const out = new Map<string, CodeEnrichment>();
  for (const row of r.rows) {
    out.set(row.code, {
      duty_info: dutyInfoFromColumns(row.duty_rate_pct, row.duty_status),
      procedures: (row.procedures ?? [])
        .map((c) => byProcCode.get(c))
        .filter((p): p is ProcedureInfo => !!p),
    });
  }
  return out;
}

/** Single-code variant; convenience for dispatch + trace routes. */
export async function enrichCode(
  code: string | null,
  log?: LookupLogger,
): Promise<CodeEnrichment> {
  if (!code) return { duty_info: null, procedures: [] };
  const map = await enrichCodes([code], log);
  return map.get(code) ?? { duty_info: null, procedures: [] };
}

export interface CatalogPath {
  path_en: string | null;
  path_ar: string | null;
}

const PATH_SEPARATOR = ' > ';

/**
 * Pull the bilingual breadcrumb for a single HS code from
 * `zatca_hs_code_display`.
 *
 * PR13 (2026-05-20): when the stored `path_en` is short (a single
 * segment — e.g. heading-level codes that have no displayable
 * ancestor chain in the catalog), reconstruct the breadcrumb by
 * joining ancestor labels from `path_codes` into a path. This
 * guarantees the API caller always sees the full hierarchy in
 * `resolved_hs_code_description.full_hierarchy`, even without the
 * trace.
 *
 * Why path_en can be short: the ingest script's depth calculation
 * (drizzle/0027) builds path_en from leading-dash hierarchy in
 * description text. Some codes (chapter-padded, single-level
 * children) genuinely have no parent description above them. For
 * those, joining label_en from each ancestor in path_codes gives
 * us a full chapter > heading > subheading > leaf rendering.
 */
export async function lookupCatalogPath(code: string | null): Promise<CatalogPath> {
  if (!code) return { path_en: null, path_ar: null };
  const pool = getPool();
  const r = await pool.query<{
    path_en: string | null;
    path_ar: string | null;
    path_codes: string[] | null;
  }>(
    `SELECT path_en, path_ar, path_codes
       FROM zatca_hs_code_display
       WHERE code = $1
       LIMIT 1`,
    [code],
  );
  const row = r.rows[0];
  if (!row) return { path_en: null, path_ar: null };

  const stored_en = row.path_en;
  const stored_ar = row.path_ar;
  // path_codes is JSONB; pg returns it as a parsed JS array.
  const ancestorCodes: string[] = Array.isArray(row.path_codes) ? row.path_codes : [];

  // If the stored path already has >= 2 segments, it's a full
  // breadcrumb — return as-is (current behaviour preserved).
  const hasMultiSegmentEn =
    typeof stored_en === 'string' && stored_en.includes(PATH_SEPARATOR);
  const hasMultiSegmentAr =
    typeof stored_ar === 'string' && stored_ar.includes(PATH_SEPARATOR);
  if (hasMultiSegmentEn && hasMultiSegmentAr) {
    return { path_en: stored_en, path_ar: stored_ar };
  }

  // Short path detected. Rebuild from ancestor labels.
  if (ancestorCodes.length < 2) {
    // Genuinely a top-level code (just self). Nothing to rebuild;
    // return the stored single-segment path verbatim.
    return { path_en: stored_en, path_ar: stored_ar };
  }

  const labels = await pool.query<{
    code: string;
    label_en: string | null;
    label_ar: string | null;
  }>(
    `SELECT code, label_en, label_ar
       FROM zatca_hs_code_display
       WHERE code = ANY($1::text[])`,
    [ancestorCodes],
  );
  const byCode = new Map<string, { en: string | null; ar: string | null }>();
  for (const r of labels.rows) {
    byCode.set(r.code, { en: r.label_en, ar: r.label_ar });
  }
  const joinedEn = ancestorCodes
    .map((c) => byCode.get(c)?.en ?? '')
    .filter((s) => s.length > 0)
    .join(PATH_SEPARATOR);
  const joinedAr = ancestorCodes
    .map((c) => byCode.get(c)?.ar ?? '')
    .filter((s) => s.length > 0)
    .join(PATH_SEPARATOR);

  return {
    path_en: joinedEn.length > 0 ? joinedEn : stored_en,
    path_ar: joinedAr.length > 0 ? joinedAr : stored_ar,
  };
}
