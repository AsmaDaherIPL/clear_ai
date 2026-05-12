/**
 * Evidence gate. Two refusal cases only:
 *   - top score below minScore       → 'weak_retrieval'
 *   - thin input (≤1 token) AND top-K straddles unrelated chapters
 *                                    → 'ambiguous_top_candidates'
 *
 * The old gap-based check was too aggressive once we moved to weighted
 * RRF: catalog families produce naturally tight clusters (top-1 vs top-2
 * deltas of 0.0003 are common for "Earrings"-style single-noun queries),
 * and refusing on small gaps zeroed out Track A on perfectly classifiable
 * inputs. The picker has `no_fit` as its own refusal mechanism — let it
 * make the call.
 */
import type { Candidate } from '../../../../inference/retrieval/retrieve.js';

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
  /** Retained for backwards-compat with config rows; no longer enforced. */
  minGap?: number;
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

  return { passed: true, topRetrievalScore: top, top2Gap: gap };
}
