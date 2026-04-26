/**
 * Evidence Gate (ADR-0002).
 *
 * The LLM never rescues weak retrieval. Before any LLM call, check that the top
 * candidate's RRF score exceeds MIN_SCORE and the gap to the runner-up exceeds
 * MIN_GAP for this endpoint. If either fails, the gate FAILS and we abstain.
 */
import type { Candidate } from '../retrieval/retrieve.js';

export type GateOutcome =
  | { passed: true; topRetrievalScore: number; top2Gap: number }
  | {
      passed: false;
      reason: 'weak_retrieval' | 'ambiguous_top_candidates' | 'invalid_prefix';
      topRetrievalScore: number;
      top2Gap: number;
    };

export interface GateThresholds {
  minScore: number;
  minGap: number;
}

export function evaluateGate(
  candidates: Candidate[],
  t: GateThresholds
): GateOutcome {
  if (candidates.length === 0) {
    return { passed: false, reason: 'invalid_prefix', topRetrievalScore: 0, top2Gap: 0 };
  }
  const top = candidates[0]!.rrf_score;
  const second = candidates[1]?.rrf_score ?? 0;
  const gap = top - second;

  if (top < t.minScore) {
    return { passed: false, reason: 'weak_retrieval', topRetrievalScore: top, top2Gap: gap };
  }
  if (gap < t.minGap) {
    return { passed: false, reason: 'ambiguous_top_candidates', topRetrievalScore: top, top2Gap: gap };
  }
  return { passed: true, topRetrievalScore: top, top2Gap: gap };
}
