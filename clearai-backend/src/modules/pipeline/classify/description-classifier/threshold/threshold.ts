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
} from './evidence-gate.js';
import type { Candidate } from '../../../../../inference/retrieval/retrieve.js';

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

/**
 * Default thresholds used when operator overrides are not configured.
 *
 * Sized for raw weighted-RRF output (no max-normalisation). Reference points
 * with the default weights vec=1.0, bm25=1.5, trgm=0.5 and rrfK=60:
 *   • clean two-arm rank-1 hit: 1.0/61 + 1.5/61 ≈ 0.041
 *   • vector-only rank-1 hit:   1.0/61              ≈ 0.016
 *   • bm25-only rank-1 hit:     1.5/61              ≈ 0.025
 *   • two-arm rank-1 vs rank-2 gap (rrf only): tiny (~0.0006)
 *
 * Calibrated against post-Plan-B retrieval (text-embedding-3-large @ 1024):
 * a coherent-but-broad query like "white tshirt men long sleeve" produces
 * top-1 around 0.019 (vec ranks 1, BM25 ranks 1 but the trigram arm doesn't
 * match strongly because the query term order differs from the catalog
 * descriptions). minScore=0.015 lets that through; minGap=0.003 gives the
 * coherent-block escape room to fire when top-K straddles e.g. chapters
 * 61+62 (knit + woven garments).
 */
export const DEFAULT_THRESHOLDS: GateThresholds = {
  minScore: 0.015,
  minGap: 0.003,
};
