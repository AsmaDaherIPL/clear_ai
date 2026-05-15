/**
 * Pipeline rewrite — shared coercion helpers for identify (PR 3 + PR 4).
 *
 * Lifted from src/modules/pipeline/identify/identify.ts (current
 * anchored). The logic is unchanged; we extract it here so PR 3 (fast
 * pass) and PR 4 (web fallback) can share the same field validation
 * without duplicating ~80 lines of fragile coercion code.
 *
 * Why permissive coercion at all: LLM output is untrusted. The Zod
 * schema is `.unknown().optional().passthrough()` and the real
 * validation happens here, where we can return field-by-field defaults
 * for malformed values rather than throwing on the first wrong field.
 */
export const MAX_IDENTITY_TOKENS = 4;
export const MAX_IDENTITY_TOKEN_LENGTH = 40;
export const MAX_PRODUCTS = 8;
export const MAX_PRODUCT_LABEL_LENGTH = 200;
export const MAX_REASON_LENGTH = 200;
/**
 * Cap for the brand-only rescue `brand_alternatives` list returned by
 * identify_web on multi-category brand inputs. Bounded to keep wire
 * payload size predictable; UI typically renders the first 3-5.
 */
export const MAX_BRAND_ALTERNATIVES = 6;
export const MAX_BRAND_ALTERNATIVE_LENGTH = 120;

/** Coerce LLM family_chapter into a valid 2-digit string or null. */
export function coerceFamilyChapter(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!/^(?:0[1-9]|[1-9][0-9])$/.test(trimmed)) return null;
  return trimmed;
}

/** Clamp confidence into [0, 1]; reject non-numbers as 0. */
export function coerceConfidence(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Coerce identity_tokens: array of non-empty strings, capped at length. */
export function coerceIdentityTokens(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_IDENTITY_TOKEN_LENGTH) continue;
    out.push(trimmed);
    if (out.length >= MAX_IDENTITY_TOKENS) break;
  }
  return out;
}

/** Coerce multi_product products: array of non-empty strings, capped. */
export function coerceProducts(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PRODUCT_LABEL_LENGTH) continue;
    out.push(trimmed);
    if (out.length >= MAX_PRODUCTS) break;
  }
  return out;
}

/**
 * Coerce brand_alternatives: array of short labels describing other
 * product lines of a multi-category brand, returned by identify_web on
 * brand-only inputs. Each entry should be human-readable noun phrase
 * (e.g. "video conferencing camera", "LED signage"). Bounded length +
 * count so wire payload size is predictable.
 */
export function coerceBrandAlternatives(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_BRAND_ALTERNATIVE_LENGTH) continue;
    out.push(trimmed);
    if (out.length >= MAX_BRAND_ALTERNATIVES) break;
  }
  return out;
}
