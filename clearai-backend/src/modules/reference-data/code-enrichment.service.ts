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

/** Pull the bilingual breadcrumb for a single HS code from zatca_hs_code_display. */
export async function lookupCatalogPath(code: string | null): Promise<CatalogPath> {
  if (!code) return { path_en: null, path_ar: null };
  const pool = getPool();
  const r = await pool.query<{ path_en: string | null; path_ar: string | null }>(
    `SELECT path_en, path_ar FROM zatca_hs_code_display WHERE code = $1 LIMIT 1`,
    [code],
  );
  const row = r.rows[0];
  return { path_en: row?.path_en ?? null, path_ar: row?.path_ar ?? null };
}
