/** Parses ZATCA duty cells into a structured rate-or-status shape. */

export interface DutyInfo {
  /** Numeric % when duty is a rate; null when a status word. */
  rate_percent: number | null;
  status_en: string | null;
  status_ar: string | null;
  raw_en: string | null;
  raw_ar: string | null;
}

const PERCENT_RE = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/;

/** Returns null when both inputs are empty. */
export function parseDutyInfo(
  rawEn: string | null | undefined,
  rawAr: string | null | undefined,
): DutyInfo | null {
  const en = rawEn?.trim() || null;
  const ar = rawAr?.trim() || null;
  if (!en && !ar) return null;

  const enMatch = en ? PERCENT_RE.exec(en) : null;
  const arMatch = ar ? PERCENT_RE.exec(ar) : null;
  const ratePercent = enMatch?.[1]
    ? Number(enMatch[1])
    : arMatch?.[1]
      ? Number(arMatch[1])
      : null;

  if (ratePercent !== null && Number.isFinite(ratePercent)) {
    return { rate_percent: ratePercent, status_en: null, status_ar: null, raw_en: en, raw_ar: ar };
  }
  return { rate_percent: null, status_en: en, status_ar: ar, raw_en: en, raw_ar: ar };
}
