/** Tiny route-level helpers for the response envelope contract. */
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';

/** Spread `request_id` only when present. */
export function withRequestId(
  requestId: string | null,
): { request_id: string } | Record<string, never> {
  return requestId ? { request_id: requestId } : {};
}

/** The `model` block attached to every classification response. */
export function baseModelInfo(llm: string | null = null): {
  embedder: string;
  llm: string | null;
} {
  return { embedder: EMBEDDER_VERSION(), llm };
}

/** Strip ZATCA catalog tree-depth dashes/colons. Returns null for empty input. */
export function trimCatalogDashes(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const out = s
    .replace(/^[\s\-–—·.•:]+/, '')
    .replace(/[\s\-–—·.•:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length === 0 ? null : out;
}

/** Trim catalog dashes on every alternative in place. */
export function trimAlternativeDashes<
  T extends { description_en: string | null; description_ar: string | null },
>(alts: T[]): T[] {
  for (const a of alts) {
    a.description_en = trimCatalogDashes(a.description_en);
    a.description_ar = trimCatalogDashes(a.description_ar);
  }
  return alts;
}
