/**
 * Response-time enrichment of hs_codes.procedures (e.g. "2,28,61") into
 * structured ProcedureInfo[] via a single ANY-bound lookup. Order preserved.
 */
import { getPool } from '../db/client.js';

export interface ProcedureInfo {
  code: string;
  description_ar: string;
  /** True when the description ends with `(ملغي)` (repealed). */
  is_repealed: boolean;
}

/** Pino-compatible logger shape. */
export interface LookupLogger {
  warn(obj: unknown, msg?: string): void;
}

/** Tolerates whitespace, doubled commas, duplicates. */
export function parseProceduresField(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const code = part.trim();
    if (!code) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** Returns [] on null/empty. Codes not in procedure_codes warn-log + drop. */
export async function lookupProcedures(
  rawField: string | null | undefined,
  log?: LookupLogger,
): Promise<ProcedureInfo[]> {
  const codes = parseProceduresField(rawField);
  if (codes.length === 0) return [];

  const pool = getPool();
  const r = await pool.query<{
    code: string;
    description_ar: string;
    is_repealed: boolean;
  }>(
    `SELECT code, description_ar, is_repealed
       FROM procedure_codes
       WHERE code = ANY($1::varchar[])`,
    [codes],
  );

  const byCode = new Map<string, ProcedureInfo>(
    r.rows.map((row) => [
      row.code,
      {
        code: row.code,
        description_ar: row.description_ar,
        is_repealed: row.is_repealed,
      },
    ]),
  );

  const out: ProcedureInfo[] = [];
  const missing: string[] = [];
  for (const code of codes) {
    const hit = byCode.get(code);
    if (hit) out.push(hit);
    else missing.push(code);
  }

  if (missing.length > 0 && log) {
    log.warn(
      { missing_procedure_codes: missing, raw_field: rawField },
      'procedure_codes lookup missing rows — skipping; reseed procedure_codes if this persists',
    );
  }

  return out;
}
