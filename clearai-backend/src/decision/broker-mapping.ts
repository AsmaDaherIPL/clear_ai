/**
 * Broker-mapping lookup — Phase 7 of the v3 alternatives redesign.
 *
 * Reads `broker_code_mapping` (populated from
 * Naqel_HS_code_mapping_lookup.xlsx) and resolves a merchant-supplied
 * code to the broker's canonical 12-digit ZATCA target. This is the
 * deterministic short-circuit that runs BEFORE the LLM picker on
 * `/classify/expand` (and as a soft hint on `/classify/describe`):
 * if the broker has already hand-curated the right answer for this
 * exact merchant code, we ship it without burning an LLM call.
 *
 * Lookup strategy:
 *   1. Exact match on the digit-only normalised input.
 *   2. Prefix-walk fallback: if the exact code isn't in the table,
 *      progressively trim trailing digits and re-check. The broker
 *      table is keyed on whatever literal form the merchant used
 *      (often 10-digit), so a 12-digit input may not match exactly
 *      but its 10-digit prefix might. We stop at length 6 — anything
 *      shorter than a subheading is too coarse for the broker's table
 *      to be authoritative.
 *
 * Returns null when no match is found at any prefix length, or when
 * the table is empty (e.g. the ingest hasn't been run).
 *
 * Pure SQL, no LLM — fast (~5ms p95) and idempotent.
 */
import { getPool } from '../db/client.js';

export interface BrokerMappingHit {
  /** The 12-digit ZATCA target the broker mapped this input to. */
  targetCode: string;
  /** The broker's canonical Arabic description for this code, if any. */
  targetDescriptionAr: string | null;
  /** Source row reference from the spreadsheet (for traceability). */
  sourceRowRef: string | null;
  /** Length of the prefix that matched. 12 = exact, < 12 = walked-up. */
  matchedLength: number;
  /** The exact normalised key that matched. */
  matchedClientCode: string;
}

export interface BrokerMappingOpts {
  /**
   * Minimum prefix length the walk-up will descend to. Default 6.
   * The broker's table is keyed on merchant-supplied codes (8/10/12 digit
   * are the common shapes). Walking up below HS-6 produces too many
   * collisions to be authoritative.
   */
  minPrefix?: number;
}

const DIGITS_ONLY = /[^\d]/g;

/**
 * Look up a merchant-supplied code (in any format — dotted, padded, etc)
 * against the broker's hand-curated mapping table. Returns the match or
 * null.
 */
export async function lookupBrokerMapping(
  rawCode: string,
  opts: BrokerMappingOpts = {},
): Promise<BrokerMappingHit | null> {
  const minPrefix = opts.minPrefix ?? 6;
  const normalised = rawCode.replace(DIGITS_ONLY, '');
  if (normalised.length < minPrefix) return null;

  const pool = getPool();

  // Build a list of candidate keys, longest first. We try the literal
  // input, then progressively trim trailing digits. Single SQL query
  // with ORDER BY length(client_code_norm) DESC so the longest match
  // wins when multiple prefixes happen to be in the table.
  const candidates: string[] = [];
  for (let len = normalised.length; len >= minPrefix; len--) {
    candidates.push(normalised.slice(0, len));
  }

  const r = await pool.query<{
    client_code_norm: string;
    target_code: string;
    target_description_ar: string | null;
    source_row_ref: string | null;
  }>(
    `SELECT client_code_norm, target_code, target_description_ar, source_row_ref
       FROM broker_code_mapping
      WHERE client_code_norm = ANY($1::varchar[])
      ORDER BY length(client_code_norm) DESC
      LIMIT 1`,
    [candidates],
  );

  const row = r.rows[0];
  if (!row) return null;
  return {
    targetCode: row.target_code,
    targetDescriptionAr: row.target_description_ar,
    sourceRowRef: row.source_row_ref,
    matchedLength: row.client_code_norm.length,
    matchedClientCode: row.client_code_norm,
  };
}
