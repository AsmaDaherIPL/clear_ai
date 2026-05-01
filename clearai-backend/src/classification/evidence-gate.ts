/**
 * Evidence gate. Refuses any LLM call when retrieval is weak (top score below
 * MIN_SCORE) or ambiguous across families (top1 vs top2 gap below MIN_GAP and
 * different HS-4 headings). Also refuses single-token inputs whose top-K
 * spans 3+ chapters.
 */
import type { Candidate } from '../retrieval/retrieve.js';

const THIN_INPUT_TOPK = 5;
const THIN_INPUT_MIN_CHAPTER_SPREAD = 3;

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
  t: GateThresholds,
  /** Post-cleanup input. When passed, also refuses thin-input cross-chapter spread. */
  effectiveDescription?: string,
): GateOutcome {
  if (candidates.length === 0) {
    return { passed: false, reason: 'invalid_prefix', topRetrievalScore: 0, top2Gap: 0 };
  }
  const top = candidates[0]!.rrf_score;
  const second = candidates[1]?.rrf_score ?? 0;
  const gap = top - second;

  // Thin-input check runs first: high score + real gap can be lexical (e.g. "books").
  if (effectiveDescription) {
    const tokenCount = effectiveDescription.trim().split(/\s+/).filter(Boolean).length;
    if (tokenCount <= 1) {
      const topKChapters = new Set(
        candidates.slice(0, THIN_INPUT_TOPK).map((c) => c.code.slice(0, 2)),
      );
      if (topKChapters.size >= THIN_INPUT_MIN_CHAPTER_SPREAD) {
        return {
          passed: false,
          reason: 'ambiguous_top_candidates',
          topRetrievalScore: top,
          top2Gap: gap,
        };
      }
    }
  }

  if (top < t.minScore) {
    return { passed: false, reason: 'weak_retrieval', topRetrievalScore: top, top2Gap: gap };
  }

  if (gap < t.minGap) {
    // Narrow-family escape: top-1 and top-2 in the same HS-4 heading → picker disambiguates.
    const top1Heading = candidates[0]!.code.slice(0, 4);
    const top2Heading = candidates[1]?.code.slice(0, 4);
    const sameFamily = top2Heading !== undefined && top1Heading === top2Heading;
    if (!sameFamily) {
      return {
        passed: false,
        reason: 'ambiguous_top_candidates',
        topRetrievalScore: top,
        top2Gap: gap,
      };
    }
  }

  return { passed: true, topRetrievalScore: top, top2Gap: gap };
}
