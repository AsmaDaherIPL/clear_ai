/**
 * Stage 0a — Parse (deterministic, no LLM).
 *
 * Extracts structured fields from a CanonicalLineItem and determines the
 * merchant code state. Hard-rejects when no description is present —
 * a code alone cannot be classified or sanity-checked.
 */
import type { CanonicalLineItem } from '../../operators/operator-config.types.js';
import type { MerchantCodeState, ParsedItem } from '../shared/pipeline.types.js';

// ASIN: B0 + 8 uppercase alphanumerics
const ASIN_RE = /\b(B0[A-Z0-9]{8})\b/g;
// EAN-13 or EAN-8
const EAN_RE = /\b(\d{8}|\d{13})\b/g;
// GTIN-14
const GTIN_RE = /\b(\d{14})\b/g;

interface MerchantCodeParse {
  state: MerchantCodeState;
  /** Digits as supplied (no padding). Null when absent/malformed. */
  raw: string | null;
  /** Padded to next valid HS boundary (6/8/10/12). Null when absent/malformed. */
  normalized: string | null;
}

// Naqel zero-strips trailing zeros from canonical 12-digit codes. A 7-digit
// "8518311" was originally "851831100000"; recover by padding to the next
// valid boundary (HS8 here) so the codebook walk has a real prefix to expand.
function classifyMerchantCode(raw: string | null | undefined): MerchantCodeParse {
  if (!raw || raw.trim() === '') return { state: 'absent', raw: null, normalized: null };
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 12) {
    return { state: 'malformed', raw: digits || null, normalized: null };
  }
  if (digits.length === 12) return { state: 'twelve_digit', raw: digits, normalized: digits };
  if (digits.length === 11) return { state: 'twelve_digit', raw: digits, normalized: digits + '0' };
  if (digits.length === 10) return { state: 'short_prefix', raw: digits, normalized: digits };
  if (digits.length === 9) return { state: 'short_prefix', raw: digits, normalized: digits + '0' };
  if (digits.length === 8) return { state: 'short_prefix', raw: digits, normalized: digits };
  if (digits.length === 7) return { state: 'short_prefix', raw: digits, normalized: digits + '0' };
  return { state: 'short_prefix', raw: digits, normalized: digits }; // length === 6
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
  const codeParse = classifyMerchantCode(rawCode);

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
      raw_merchant_code: codeParse.raw,
      normalized_merchant_code: codeParse.normalized,
      merchant_code_state: codeParse.state,
      raw_description: desc,
      identifiers,
      currency_code: typeof line.currencyCode === 'string' ? line.currencyCode : null,
      value_amount: valueAmount,
    },
  };
}
