/**
 * Track A / Threshold check — deterministic score math, no LLM.
 *
 * Refuses to call the Picker when retrieval is weak (top score below
 * MIN_SCORE) or ambiguous across tariff families. Delegates to the existing
 * evidence-gate implementation.
 */
import {
  evaluateGate,
  type GateOutcome,
  type GateThresholds,
} from '../../../pipeline/track-a-description/threshold/evidence-gate.js';
import type { Candidate } from '../../../../inference/retrieval/retrieve.js';

export type { GateOutcome, GateThresholds };

export interface ThresholdOutput {
  passed: boolean;
  gate: GateOutcome;
}

export function runThreshold(
  candidates: Candidate[],
  effective_description: string,
  thresholds: GateThresholds,
): ThresholdOutput {
  const gate = evaluateGate(candidates, thresholds, effective_description);
  return { passed: gate.passed, gate };
}

/** Default thresholds used when operator overrides are not configured. */
export const DEFAULT_THRESHOLDS: GateThresholds = {
  minScore: 0.3,
  minGap: 0.05,
};
