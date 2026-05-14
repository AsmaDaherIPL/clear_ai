/**
 * Pick stage (anchored pipeline, stage 3 of 3).
 *
 * Stub placeholder. PR-A-4 will implement this stage.
 *
 * Contract:
 *   input:  PickInput (identify + constrain results)
 *   output: PickResult (accepted code + confidence + GIR cited, or escalate)
 *   engine: retrieval call under the scope's prefix filter + one
 *           Sonnet picker call with the simplified 3-value fit verdict
 *           (fits / partial / does_not_fit — no chapter_adjacent or
 *           partial_family because constrain has already anchored the
 *           retrieval neighborhood).
 *   absorbs: today's retrieval + threshold + picker into a single stage
 *            that operates over a pre-narrowed candidate set.
 */
import type { PickInput, PickResult } from './pick.types.js';

export function runPick(_input: PickInput): Promise<PickResult> {
  throw new Error('anchored pipeline not yet implemented: pick stage stub (PR-A-4)');
}
