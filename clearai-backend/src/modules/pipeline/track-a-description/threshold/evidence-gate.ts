/**
 * Evidence gate. Refuses to call the picker when retrieval is weak (top
 * score below MIN_SCORE) or genuinely ambiguous across unrelated tariff
 * families. The narrow-family / coherent-block escapes below let the
 * picker disambiguate when the top results obviously belong to one
 * product domain (e.g. all garments under chapter 61/62) — refusing in
 * that case zeroes out Track A's signal and forces a verdict escalation
 * for what should be a routine classification.
 *
 * Coherence rules (in order):
 *   1. Top-1 and top-2 share HS-4 heading              → pass (always did)
 *   2. Top-3 codes live in ≤2 chapters AND those chapters are adjacent
 *      pairs from the same product family (e.g. 61+62 garments,
 *      64+65 footwear/headgear)                        → pass (NEW)
 *   3. Top-3 codes share one HS-2 chapter              → pass (NEW)
 *   4. Otherwise                                       → refuse
 */
import type { Candidate } from '../../../../inference/retrieval/retrieve.js';

const THIN_INPUT_TOPK = 5;
const THIN_INPUT_MIN_CHAPTER_SPREAD = 3;
const COHERENT_BLOCK_TOPK = 3;

/**
 * Adjacent-chapter pairs that share a common product domain in the HS
 * codebook. When top-K straddles one of these pairs (e.g. cotton t-shirt
 * "610910" alongside men's woven shirt "620500"), retrieval is locating
 * the right product family — the picker is the right tool to choose
 * between knit and woven, not the threshold gate.
 */
const ADJACENT_CHAPTER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['61', '62'], // knitted garments + woven garments
  ['64', '65'], // footwear + headgear
  ['44', '45'], // wood + cork
  ['68', '69'], // stone/cement + ceramic
  ['72', '73'], // iron & steel + articles thereof
  ['74', '75'], // copper + nickel
  ['84', '85'], // machinery + electrical machinery
  ['86', '87'], // rail + road vehicles
  ['90', '91'], // optical + clocks/watches
];

function isAdjacentPair(a: string, b: string): boolean {
  if (a === b) return true;
  return ADJACENT_CHAPTER_PAIRS.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x),
  );
}

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
    // Narrow-family escape (rule 1): top-1 and top-2 in the same HS-4
    // heading → picker disambiguates between leaf variants.
    const top1Heading = candidates[0]!.code.slice(0, 4);
    const top2Heading = candidates[1]?.code.slice(0, 4);
    const sameHeading = top2Heading !== undefined && top1Heading === top2Heading;

    if (sameHeading) {
      return { passed: true, topRetrievalScore: top, top2Gap: gap };
    }

    // Coherent-block escape (rules 2 + 3): top-K is dominated by one
    // product family even though top-1 and top-2 differ in HS-4. Picker
    // is the right tool to disambiguate within a coherent product
    // domain — refusing here loses Track A entirely and forces an
    // unnecessary verdict escalation.
    const topKChapters = new Set(
      candidates.slice(0, COHERENT_BLOCK_TOPK).map((c) => c.code.slice(0, 2)),
    );

    if (topKChapters.size === 1) {
      // Rule 3: all top-3 in one chapter.
      return { passed: true, topRetrievalScore: top, top2Gap: gap };
    }
    if (topKChapters.size === 2) {
      // Rule 2: two chapters, must be an adjacent pair from the same
      // product domain (e.g. 61+62 garments).
      const [c1, c2] = [...topKChapters];
      if (c1 && c2 && isAdjacentPair(c1, c2)) {
        return { passed: true, topRetrievalScore: top, top2Gap: gap };
      }
    }

    return {
      passed: false,
      reason: 'ambiguous_top_candidates',
      topRetrievalScore: top,
      top2Gap: gap,
    };
  }

  return { passed: true, topRetrievalScore: top, top2Gap: gap };
}
