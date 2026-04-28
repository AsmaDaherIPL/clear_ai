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
