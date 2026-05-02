/**
 * Duty info helper.
 *
 * Post-0031: parsing now happens once at ingest time (see migration
 * 0031_procedures_array_duty_struct.sql). Routes read the structured
 * columns hs_codes.duty_rate_pct + hs_codes.duty_status directly and
 * shape them into the API response via dutyInfoFromColumns().
 *
 * API shape (per ADR-0025 commit C decision: drop raw_en/raw_ar):
 *
 *   { rate_percent: number | null,
 *     status:       null | 'exempted' | 'prohibited_import' | 'prohibited_export' | 'prohibited_both' }
 *
 *   • A pure rate row: { rate_percent: 5, status: null }
 *   • An exemption:    { rate_percent: null, status: 'exempted' }
 *   • A prohibition:   { rate_percent: null, status: 'prohibited_import' }
 *   • No duty data:    null  (the helper returns null, route omits the key)
 */

export type DutyStatus =
  | 'exempted'
  | 'prohibited_import'
  | 'prohibited_export'
  | 'prohibited_both';

export interface DutyInfo {
  /** Numeric % when the row carries a rate; null otherwise. */
  rate_percent: number | null;
  /** Non-rate status word; null when the row IS a rate. */
  status: DutyStatus | null;
}

/**
 * Build the API DutyInfo from the structured DB columns. Returns null
 * when the row has no duty data at all (both inputs null/empty).
 *
 * The 'rate' status sentinel is collapsed into `{ rate_percent: N, status: null }`
 * so the public response doesn't leak the internal enum value.
 */
export function dutyInfoFromColumns(
  ratePct: number | string | null | undefined,
  status: string | null | undefined,
): DutyInfo | null {
  if (status === null || status === undefined) {
    // Defensive: status NULL but rate present is impossible per the
    // hs_codes_duty_consistency_chk CHECK; treat as no-data.
    return null;
  }
  if (status === 'rate') {
    if (ratePct === null || ratePct === undefined) return null;
    const n = typeof ratePct === 'number' ? ratePct : Number(ratePct);
    if (!Number.isFinite(n)) return null;
    return { rate_percent: n, status: null };
  }
  if (
    status === 'exempted' ||
    status === 'prohibited_import' ||
    status === 'prohibited_export' ||
    status === 'prohibited_both'
  ) {
    return { rate_percent: null, status };
  }
  // Unknown status string — defensive null.
  return null;
}
