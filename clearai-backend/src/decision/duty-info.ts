/**
 * Parse the bilingual ZATCA duty strings into a structured shape.
 *
 * The catalog stores duty as two columns (`duty_en`, `duty_ar`) but the
 * values are essentially one attribute that's either:
 *   - a numeric percentage ("5 %", "6.5 %", "12 %") — identical EN/AR
 *   - a status word ("Exempted" / "معفاة", "Prohibited from Importing"
 *     / "ممنوع الاستيراد") — translations of the same status
 *
 * The structured form distinguishes these two cases so the frontend can:
 *   - Render percentages as a small numeric pill (`5%`).
 *   - Render statuses with the user's preferred language (or both with a
 *     subtle separator).
 *   - Decide intelligently when to bold or warn (e.g. "Prohibited" should
 *     be a hard warning, "Exempted" is fine, "5%" is just info).
 */

export interface DutyInfo {
  /** Parsed numeric percentage when duty is a rate (e.g. 5, 6.5, 12). Null when duty is a status word. */
  rate_percent: number | null;
  /** English status word when duty is non-numeric (e.g. "Exempted", "Prohibited from Importing"). */
  status_en: string | null;
  /** Arabic translation of the status word. */
  status_ar: string | null;
  /** Raw EN string from the catalog, kept verbatim for fidelity. */
  raw_en: string | null;
  /** Raw AR string from the catalog, kept verbatim for fidelity. */
  raw_ar: string | null;
}

const PERCENT_RE = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/;

/**
 * Parse the catalog's duty_en / duty_ar columns into a structured DutyInfo.
 * Returns null when both inputs are null/empty (heading-level rows often
 * have no duty — the rates live at the leaves).
 */
export function parseDutyInfo(
  rawEn: string | null | undefined,
  rawAr: string | null | undefined,
): DutyInfo | null {
  const en = rawEn?.trim() || null;
  const ar = rawAr?.trim() || null;
  if (!en && !ar) return null;

  // Try to parse a numeric percentage from EN first (the primary signal),
  // fall back to AR. Both columns hold the same number for the numeric case.
  const enMatch = en ? PERCENT_RE.exec(en) : null;
  const arMatch = ar ? PERCENT_RE.exec(ar) : null;
  const ratePercent = enMatch?.[1]
    ? Number(enMatch[1])
    : arMatch?.[1]
      ? Number(arMatch[1])
      : null;

  if (ratePercent !== null && Number.isFinite(ratePercent)) {
    return {
      rate_percent: ratePercent,
      status_en: null,
      status_ar: null,
      raw_en: en,
      raw_ar: ar,
    };
  }

  // Non-numeric: status word like "Exempted" / "Prohibited from Importing".
  // Keep both languages — they're translations and the UI may prefer one.
  return {
    rate_percent: null,
    status_en: en,
    status_ar: ar,
    raw_en: en,
    raw_ar: ar,
  };
}
