/**
 * Retrieval-grounded "did the system understand this input?" check.
 *
 * The signal is **chapter agreement among the top-N retrieved candidates.**
 * Coherent product descriptions cluster in 1–2 HS-2 chapters; ambiguous or
 * jargon-heavy inputs scatter across many unrelated chapters because
 * retrieval is grasping at lexical/semantic straws.
 *
 * Why a retrieval signal rather than asking the LLM "do you understand?":
 *  1. Free — we already paid for retrieval.
 *  2. Self-calibrating — grounded in our actual tariff corpus, not an LLM's
 *     training data. If the corpus covers an item, scores show it; if not,
 *     scores collapse.
 *  3. Honest by construction — an LLM may confidently mis-identify; retrieval
 *     cannot lie about its own scores.
 *
 * Threshold (`UNDERSTOOD_MAX_DISTINCT_CHAPTERS`) and window size
 * (`UNDERSTOOD_TOP_K_describe`) are loaded from setup_meta so the team can
 * tune without redeploys.
 */
import type { Candidate } from '../retrieval/retrieve.js';

export type UnderstandingReason = 'incoherent_top_set';

export interface UnderstandingResult {
  understood: boolean;
  reason: UnderstandingReason | null;
  /** Distinct HS-2 chapters among top-5 candidates. 1 = highly coherent. */
  distinctChapters: number;
  /** The chapters themselves, sorted, for logging/debugging. */
  chapters: string[];
  /** The threshold that was applied (max distinct chapters tolerated). */
  threshold: number;
}

export function checkUnderstanding(
  candidates: Candidate[],
  opts: { maxDistinctChapters: number; topK: number },
): UnderstandingResult {
  const window = candidates.slice(0, opts.topK);
  const chapters = Array.from(new Set(window.map((c) => c.code.slice(0, 2)))).sort();
  const distinctChapters = chapters.length;

  // Edge case: zero or one candidate is already a low-information situation;
  // route to the existing evidence gate to handle it. Don't claim "understood"
  // off the back of a single retrieval hit.
  if (window.length < 2) {
    return {
      understood: true,
      reason: null,
      distinctChapters,
      chapters,
      threshold: opts.maxDistinctChapters,
    };
  }

  if (distinctChapters > opts.maxDistinctChapters) {
    return {
      understood: false,
      reason: 'incoherent_top_set',
      distinctChapters,
      chapters,
      threshold: opts.maxDistinctChapters,
    };
  }

  return {
    understood: true,
    reason: null,
    distinctChapters,
    chapters,
    threshold: opts.maxDistinctChapters,
  };
}
