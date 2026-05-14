/**
 * Constrain stage (anchored pipeline, stage 2 of 3).
 *
 * Stub placeholder. PR-A-3 will implement this stage.
 *
 * Contract:
 *   input:  ConstrainInput (identify result + parsed merchant code)
 *   output: ConstrainResult (merchant resolution + retrieval scope)
 *   engine: deterministic codebook walk + small LLM-pick for partial
 *           prefixes and multi-replacement merchant codes; deterministic
 *           scope selection over the resolved merchant + identify
 *           output.
 *   absorbs: today's Track B (codebook walk, override lookup,
 *            expandWithFallback, llm_pick_among_replacements, subtree
 *            consistency check) AND the 11-rule reconciliation
 *            classifier — both collapse into a single deterministic
 *            scope decision plus the codebook resolution.
 */
import type { ConstrainInput, ConstrainResult } from './constrain.types.js';

export function runConstrain(_input: ConstrainInput): Promise<ConstrainResult> {
  throw new Error('anchored pipeline not yet implemented: constrain stage stub (PR-A-3)');
}
