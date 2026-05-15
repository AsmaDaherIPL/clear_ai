/**
 * Pipeline rewrite — Stage 5b: candidate union + dedupe (PR 7).
 *
 * Dedupe ScoredCandidates by `code`. When the same leaf is returned by
 * multiple arms, keep the one with the highest rrf_score (which arm
 * surfaced it most strongly), but tag the winner with the arm that
 * originally produced it — preserving the audit signal that lets us
 * tell whether the picker is choosing from merchant-side or
 * identify-side candidates.
 *
 * Pure function. No I/O.
 */
import type { ScoredCandidate } from '../types.js';

/**
 * Dedupe by code. For each code, keep the entry with the highest
 * rrf_score. Returns a new array; input is not mutated.
 *
 * Order is preserved by the highest-scoring entry's first appearance —
 * stable sort guarantees that if multiple arms returned the same code
 * with the same rrf_score, the earlier-listed arm's entry wins.
 */
export function dedupeCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
  if (candidates.length === 0) return [];

  // First pass: bucket by code, keep the highest-scoring per code.
  const byCode = new Map<string, ScoredCandidate>();
  for (const c of candidates) {
    const existing = byCode.get(c.code);
    if (existing === undefined || c.rrf_score > existing.rrf_score) {
      byCode.set(c.code, c);
    }
  }

  // Second pass: emit in descending rrf_score order. Ties broken by
  // first appearance in the input (Map preserves insertion order, so
  // Array.from(byCode.values()) is already first-occurrence-stable).
  const out = Array.from(byCode.values());
  out.sort((a, b) => b.rrf_score - a.rrf_score);
  return out;
}
