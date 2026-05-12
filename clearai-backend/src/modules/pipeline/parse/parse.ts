/**
 * Stage 0a — Parse (deterministic, no LLM).
 *
 * Extracts structured fields from a CanonicalLineItem and determines the
 * merchant code state. Hard-rejects when no description is present —
 * a code alone cannot be classified or sanity-checked.
 *
 * Merchant code length policy (relaxed 2026-05-12):
 *   Trailing zeros in HS codes are SEMANTIC indicators of granularity, not
 *   padding to be auto-filled. `851830000000` (HS12 leaf) and `851830` (HS6
 *   heading) are different claims with different downstream consequences.
 *
 *   Length classification:
 *     - 12 digits      → `twelve_digit`  (full HS12 leaf, may be valid or stale)
 *     - 6–11 digits    → `short_prefix`  (any subheading-or-deeper granularity;
 *                        Track B's expandWithFallback widens to the full
 *                        12-digit subtree under the supplied prefix and an
 *                        LLM picks the leaf)
 *     - 1–5 digits     → `malformed`     (heading-level HS4 or shorter — too
 *                        coarse to anchor a customs declaration)
 *     - 13+ digits     → `malformed`     (longer than HS12 — data corruption)
 *     - null / empty   → `absent`
 *
 *   Pre-relaxation we only accepted exactly {6, 8, 10, 12} and treated 7/9/11
 *   as malformed. In practice 7/9/11 happen routinely from xlsx
 *   scientific-notation autoformat losing a trailing zero, or from broker
 *   uploads where a single national-tariff digit (HS6+1) gets pasted.
 *   `expandWithFallback` already handles arbitrary lengths up to 12 by
 *   widening the prefix-subtree search, so refusing 7/9/11 was costing us
 *   real signal with no upside.
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
  // Accept any length 6–11 inclusive. Track B's expandWithFallback widens
  // the prefix-subtree search regardless of exact length; refusing 7/9/11
  // costs real signal with no upside. 1–5 digits stay malformed (HS4 or
  // shorter is too coarse for a customs declaration).
  if (digits.length >= 6 && digits.length <= 11) return 'short_prefix';
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
