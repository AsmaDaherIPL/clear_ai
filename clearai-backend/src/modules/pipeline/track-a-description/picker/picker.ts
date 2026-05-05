/**
 * Track A / Picker — standard LLM (Sonnet-tier).
 *
 * Given ranked retrieval candidates, asks the LLM to pick the best
 * 12-digit code for the description. Returns the chosen code, confidence,
 * rationale, and runner-up alternatives.
 *
 * Only called when the threshold check passed.
 */
import { llmPick } from '../../../hs-classification/classify/llm-pick.js';
import type { Candidate } from '../../../../inference/retrieval/retrieve.js';

export interface PickerOutput {
  chosen_code: string | null;
  confidence: number | null;
  rationale: string | null;
  alternatives: Array<{ code: string; rationale: string }>;
  no_fit: boolean;
  latency_ms: number;
}

export async function runPicker(
  effective_description: string,
  candidates: Candidate[],
): Promise<PickerOutput> {
  const start = Date.now();

  const result = await llmPick({
    kind: 'describe',
    query: effective_description,
    candidates,
    pathMode: 1,  // heading-only path mode; configurable via tenant setup_meta later
  });

  if (result.llmStatus !== 'ok' || result.guardTripped || result.chosenCode === null) {
    return {
      chosen_code: null,
      confidence: null,
      rationale: result.rationale,
      alternatives: [],
      no_fit: true,
      latency_ms: Date.now() - start,
    };
  }

  // Top-3 runners-up that were not chosen.
  const alternatives = candidates
    .filter((c) => c.code !== result.chosenCode)
    .slice(0, 3)
    .map((c) => ({ code: c.code, rationale: c.description_en ?? '' }));

  return {
    chosen_code: result.chosenCode,
    confidence: 0.8,  // numeric score not yet emitted by llmPick; default high-confidence
    rationale: result.rationale,
    alternatives,
    no_fit: false,
    latency_ms: Date.now() - start,
  };
}
