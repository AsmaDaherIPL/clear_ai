/**
 * Tiny route-level helpers that collapse the repeated request_id/model
 * boilerplate we'd otherwise re-spread at every logEvent / response site.
 *
 * Kept here (next to the routes) rather than in /util because they
 * encode the response-envelope contract — only routes should produce
 * these shapes.
 */
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';

/**
 * Conditional `request_id` spread: only include the key when we actually
 * have an id (i.e. logEvent succeeded). Used in JSON response bodies.
 *
 * Usage:  { ...response, ...withRequestId(requestId) }
 */
export function withRequestId(
  requestId: string | null,
): { request_id: string } | Record<string, never> {
  return requestId ? { request_id: requestId } : {};
}

/**
 * The `model` block we attach to every classification response. `llm`
 * is null on retrieval-only paths (expand / boost) and the picker model
 * id on describe.
 */
export function baseModelInfo(llm: string | null = null): {
  embedder: string;
  llm: string | null;
} {
  return { embedder: EMBEDDER_VERSION(), llm };
}

/**
 * Strip catalog tree-depth dashes from a description string before it
 * leaves the API. The ZATCA catalog encodes hierarchy depth as leading
 * `-` runs (and occasional trailing colons / hyphens), e.g.
 * `- - Other :`, `- - أحذية رياضية`. These are catalog-rendering
 * metadata, not user-facing copy. Trimmed only at the response/log
 * boundary — DB rows stay raw, and the picker keeps seeing the dashes
 * (they're a useful hierarchy hint for the model).
 *
 * Returns null on null/empty input so the response shape preserves
 * "we genuinely have no description" semantics.
 */
export function trimCatalogDashes(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const out = s
    .replace(/^[\s\-–—·.•:]+/, '')
    .replace(/[\s\-–—·.•:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length === 0 ? null : out;
}

/**
 * Trim catalog dashes on every alternative in place. Mutates the input
 * array so the same reference can be passed to both the response shape
 * and `logEvent` without divergence between persisted and shipped text.
 */
export function trimAlternativeDashes<
  T extends { description_en: string | null; description_ar: string | null },
>(alts: T[]): T[] {
  for (const a of alts) {
    a.description_en = trimCatalogDashes(a.description_en);
    a.description_ar = trimCatalogDashes(a.description_ar);
  }
  return alts;
}
