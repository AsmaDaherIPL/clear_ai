/**
 * Lookup helper for ZATCA procedures codes.
 *
 * `hs_codes.procedures` stores raw comma-separated codes (e.g. "2,28,61")
 * pulled verbatim from the source xlsx. Brokers cannot read these on
 * their own — "2,28" is meaningless without the official ZATCA دليل
 * رموز إجراءات فسح وتصدير السلع mapping each code to a regulatory body
 * and what they require.
 *
 * This module is the response-time enrichment layer: it parses the raw
 * string, resolves each code against `procedure_codes`, and returns a
 * structured array the frontend can render directly.
 *
 * Design choices:
 *
 *   - **Empty/null input** returns `[]` (not null). Easier for callers
 *     who can `if (procedures.length)` rather than null-checking.
 *
 *   - **Codes missing from the DB** are skipped silently and warn-logged.
 *     This catches bad-data drift without 500'ing a classification
 *     request — a procedures field is supplementary information, not a
 *     hard requirement of the response contract.
 *
 *   - **Repealed codes (`is_repealed = true`)** are returned alongside
 *     active ones. The frontend decides whether to show, hide, or grey
 *     them out — we don't second-guess UI policy here. Trace replay
 *     wants them visible; the result card probably doesn't.
 *
 *   - **Order is preserved** from the input string. ZATCA's catalog lists
 *     procedures in priority order (the first one is usually the most
 *     blocking), so we don't re-sort.
 */
import { getPool } from '../db/client.js';

export interface ProcedureInfo {
  /** ZATCA procedure code, e.g. "2", "28". */
  code: string;
  /** Arabic description from the official ZATCA guide. */
  description_ar: string;
  /**
   * True when the procedure is marked `(ملغي)` — repealed / no longer
   * enforced. Frontend should grey these out or filter them on the
   * result card; trace replay should still show them for fidelity.
   */
  is_repealed: boolean;
}

/**
 * Minimal logger surface — accepts Fastify's `req.log` or any pino-style
 * logger without dragging Fastify types in.
 */
export interface LookupLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * Parse the raw `procedures` cell value into individual codes.
 *
 * Tolerates:
 *   - leading/trailing whitespace ("  2 , 28  ")
 *   - empty entries from doubled commas ("2,,28")
 *   - duplicate codes ("2,2,28") — deduplicated, first-occurrence wins
 *
 * Returns an empty array when the input is null/empty/whitespace-only.
 */
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

/**
 * Resolve a raw `hs_codes.procedures` string into structured ProcedureInfo
 * objects via a single DB lookup. Returns [] for null/empty input.
 *
 * One round-trip per call (uses `= ANY($1)` so we don't N+1 across codes).
 * Codes not present in `procedure_codes` are logged at warn level and
 * dropped from the response — see module header for the rationale.
 */
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

  // Build a fast index for order-preserving assembly + missing-code detection.
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
