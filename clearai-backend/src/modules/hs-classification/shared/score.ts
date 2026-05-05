/**
 * Numeric helpers shared across retrieval response shaping.
 */

/**
 * Round to 4 decimal places and return as a number. Used everywhere we
 * surface RRF / vector / BM25 scores on the wire — keeps the JSON tidy
 * without committing to a string representation.
 */
export function round4(n: number): number {
  return Number(n.toFixed(4));
}
