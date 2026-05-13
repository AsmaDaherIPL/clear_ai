/**
 * Picker confidence — a per-classification score in [0, 1] derived from the
 * picker's annotated candidates and the fan-out of the leaf-space they sit in.
 *
 * Inspired by Zonos Classify's entropy-style confidence (relative score over
 * a candidate set, fan-out aware), but computed from data we already have —
 * no LLM logprobs needed.
 *
 * Two components:
 *
 *   1. spread_score    — how concentrated picker's positive verdicts are.
 *                        Many `fits` on a small candidate set means one clear
 *                        winner; one `fits` among many `does_not_fit` is
 *                        weaker; all-`partial` (picker hedging) is weakest.
 *
 *   2. fan_out_penalty — discount applied when the picked heading has a large
 *                        leaf space. Following Zonos's example: "sweater"
 *                        (10 subheadings) on the same evidence is higher
 *                        confidence than "other food preparations" (~600).
 *
 * The score is intentionally not calibrated — it is a *relative* signal used
 * to gate downstream rules (audit_flag, reconciliation tiebreakers), not a
 * promise that "0.85 means 85% correct".
 */

import type { AnnotatedCandidate } from '../../../shared/pipeline.types.js';

export interface PickerConfidenceInputs {
  candidates: AnnotatedCandidate[];
  /** Leaves in the picked heading's 4-digit family. Null when unknown (treated as no penalty). */
  leafCountInPickedHeading: number | null;
  /** Number of tokens in the effective_description after cleanup/research. */
  effectiveDescriptionTokens: number;
}

const FIT_WEIGHT = 3;
const PARTIAL_WEIGHT = 1;

/**
 * Compute picker_confidence. Returns null only when there are zero candidates
 * (picker had nothing to score against). All other paths return a number in
 * [0, 1].
 */
export function computePickerConfidence(inputs: PickerConfidenceInputs): number | null {
  const { candidates, leafCountInPickedHeading, effectiveDescriptionTokens } = inputs;

  if (candidates.length === 0) {
    return null;
  }

  const fitsCount = candidates.filter((c) => c.fit === 'fits').length;
  const partialCount = candidates.filter((c) => c.fit === 'partial').length;

  // No positive signal at all -> floor.
  if (fitsCount === 0 && partialCount === 0) {
    return 0;
  }

  // Spread score: weighted positive verdicts, normalized by the maximum
  // possible weight if every candidate were a `fits`. Range [0, 1].
  const positiveWeight = fitsCount * FIT_WEIGHT + partialCount * PARTIAL_WEIGHT;
  const maxWeight = candidates.length * FIT_WEIGHT;
  const spreadScore = positiveWeight / maxWeight;

  // Fan-out penalty: log10-scaled inverse of leaf count in the picked
  // heading. 10 leaves -> penalty 1.0 (no discount). 100 leaves -> 0.5.
  // 600 leaves -> ~0.36. Unknown leaf count -> 1.0 (no discount).
  const fanOutPenalty =
    leafCountInPickedHeading == null || leafCountInPickedHeading <= 10
      ? 1
      : 1 / Math.log10(leafCountInPickedHeading);

  // Token-thinness penalty: descriptions with <=3 tokens carry structurally
  // less information regardless of how many `fits` the picker emits. The
  // picker can be confidently wrong on "TORY 45" or "RESY"; we want the
  // confidence score to reflect that.
  //
  // Linear penalty: 1 token -> 0.40, 2 tokens -> 0.60, 3 tokens -> 0.80,
  // 4+ tokens -> 1.0 (no penalty).
  const tokenPenalty =
    effectiveDescriptionTokens >= 4
      ? 1
      : 0.2 + 0.2 * Math.max(effectiveDescriptionTokens, 1);

  const confidence = spreadScore * fanOutPenalty * tokenPenalty;

  // Clamp into [0, 1] defensively in case of small floating-point drift.
  return Math.max(0, Math.min(1, confidence));
}

/**
 * Pick the heading (first 4 digits) of the candidate the picker would route
 * to as the result. Convention matches reconciliation's `topFitCandidate`:
 * prefer `fits`, fall back to `partial`. Returns null when neither exists.
 */
export function pickedHeading(candidates: AnnotatedCandidate[]): string | null {
  const fits = candidates.find((c) => c.fit === 'fits');
  if (fits) return fits.code.slice(0, 4);
  const partial = candidates.find((c) => c.fit === 'partial');
  if (partial) return partial.code.slice(0, 4);
  return null;
}

/** Tokenize for the thinness penalty. Whitespace + punctuation split. */
export function countTokens(text: string): number {
  if (!text) return 0;
  return text
    .split(/[\s,;:.()/\-—–]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0).length;
}
