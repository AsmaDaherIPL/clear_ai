/**
 * Stage 0a — Parse (deterministic, no LLM).
 *
 * Extracts structured fields from a CanonicalLineItem and determines the
 * merchant code state. Hard-rejects when no description is present —
 * a code alone cannot be classified or sanity-checked.
 *
 * Merchant code length policy:
 *   Trailing zeros in HS codes are SEMANTIC indicators of granularity, not
 *   padding to be auto-filled. `851830000000` (HS12 leaf) and `851830` (HS6
 *   heading) are different claims with different downstream consequences.
 *   Valid lengths are exactly {6, 8, 10, 12}; anything else is `malformed`.
 *   We do NOT pad 7/9/11-digit inputs — those almost certainly come from
 *   data corruption upstream (e.g. xlsx scientific-notation truncation,
 *   fixed in PR A 2026-05-10) and should surface as `malformed` rather
 *   than be silently promoted to a confident wrong code.
 */
import type { CanonicalLineItem } from '../../operators/operator-config.types.js';
import type { MerchantCodeState, ParsedItem } from '../shared/pipeline.types.js';

// ASIN: B0 + 8 uppercase alphanumerics
const ASIN_RE = /\b(B0[A-Z0-9]{8})\b/g;
// EAN-13 or EAN-8
const EAN_RE = /\b(\d{8}|\d{13})\b/g;
// GTIN-14
const GTIN_RE = /\b(\d{14})\b/g;

function classifyMerchantCode(raw: string | null | undefined): MerchantCodeState {
  if (!raw || raw.trim() === '') return 'absent';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12) return 'twelve_digit';
  if (digits.length === 6 || digits.length === 8 || digits.length === 10) return 'short_prefix';
  return 'malformed';
}

export type ParseReject = { rejected: true; reason: 'no_description' };
export type ParseAccept = { rejected: false; item: ParsedItem };
export type ParseOutcome = ParseReject | ParseAccept;

export function parseItem(line: CanonicalLineItem): ParseOutcome {
  const desc = typeof line.description === 'string' ? line.description.trim() : null;

  if (!desc) {
    return { rejected: true, reason: 'no_description' };
  }

  const rawCode = typeof line.merchantHsCode === 'string' ? line.merchantHsCode : null;
  const digitsOnly = rawCode ? rawCode.replace(/\D/g, '') : null;
  const merchant_code_state = classifyMerchantCode(rawCode);

  const identifiers: ParsedItem['identifiers'] = [];

  for (const m of desc.matchAll(ASIN_RE)) {
    identifiers.push({ type: 'asin', value: m[1]! });
  }
  for (const m of desc.matchAll(EAN_RE)) {
    // Skip if already matched as GTIN (length 14 already excluded by EAN_RE, but
    // EAN-8 can collide with partial GTINs — keep both as different types).
    identifiers.push({ type: 'ean', value: m[1]! });
  }
  for (const m of desc.matchAll(GTIN_RE)) {
    identifiers.push({ type: 'gtin', value: m[1]! });
  }

  const valueAmount =
    typeof line.valueAmount === 'number'
      ? line.valueAmount
      : typeof line.valueAmount === 'string'
        ? parseFloat(line.valueAmount) || null
        : null;

  return {
    rejected: false,
    item: {
      raw_merchant_code: digitsOnly || null,
      merchant_code_state,
      raw_description: desc,
      identifiers,
      currency_code: typeof line.currencyCode === 'string' ? line.currencyCode : null,
      value_amount: valueAmount,
    },
  };
}
