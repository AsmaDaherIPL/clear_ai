/**
 * Identify stage (anchored pipeline, stage 1 of 3).
 *
 * Stub placeholder. PR-A-2 will implement this stage.
 *
 * Contract:
 *   input:  raw_description (blinded to merchant code, per the
 *           rationale's anchoring-avoidance principle)
 *   output: IdentifyResult (see identify.types.ts)
 *   engine: one Sonnet call with web tool, single prompt that fuses
 *           today's cleanup + research-with-web + family-hint logic.
 */
import type { IdentifyResult } from './identify.types.js';

export function runIdentify(_raw_description: string): Promise<IdentifyResult> {
  throw new Error('anchored pipeline not yet implemented: identify stage stub (PR-A-2)');
}
