/**
 * Evidence Gate (ADR-0002).
 *
 * The LLM never rescues weak retrieval. Before any LLM call, check that
 * the top candidate's RRF score exceeds MIN_SCORE and that retrieval
 * isn't catastrophically ambiguous (top1 vs top2 gap < MIN_GAP). If
 * either fails, the gate FAILS and we abstain.
 *
 * Refinement (olive-oil bug): "ambiguous" used to fire whenever the
 * gap was small, regardless of WHO the top candidates were. But on
 * inputs like "extra virgin olive oil" retrieval converges sharply on
 * a narrow family (1509.20 / 1509.30 / 1509.40 — all olive-oil
 * variants). Top1 and top2 normalise to ~1.0 / ~0.99 — gap < MIN_GAP
 * — and the gate refused, dropping the user into best-effort heading
 * padding (`150900000000`) when the picker would have happily chosen
 * the right leaf.
 *
 * The fix: the "ambiguous" rejection now only fires when the top
 * candidates span DIFFERENT HS-4 headings. Within a single heading
 * family any pick is in-the-right-ballpark and the picker is the
 * right tool to disambiguate, not abstention.
 *
 * Thin-input refinement (books bug): a single-word query like "books"
 * could match 4905.20 ("In book form" — under MAPS), 4901.99 (printed
 * books), 4820 (notebooks), 8543.70 (e-books), all at high RRF scores.
 * Top-1 vs top-2 had a real lexical gap, so the standard MIN_GAP check
 * passed and the picker confidently chose the maps-scoped leaf — wrong.
 * When the input is one token AND retrieval spans multiple chapters,
 * any "strong match" is illusory: it's lexical similarity, not semantic
 * confidence. We refuse and route to needs_clarification instead.
 */
import type { Candidate } from '../retrieval/retrieve.js';

/**
 * Top-K window we inspect for cross-chapter spread on the thin-input
 * check. 5 is a balance: large enough to detect a real spread (more
 * than 2 chapters represented = retrieval is hedging), small enough
 * that one outlier in position 8 doesn't trip the rule on a
 * fundamentally-coherent retrieval set.
 */
const THIN_INPUT_TOPK = 5;
/**
 * Minimum distinct chapters in the top-K window before we treat the
 * input as too ambiguous to auto-classify. Two chapters is normal
 * (e.g. 6109 cotton t-shirts vs 6105 knitted shirts both showing up
 * for "t-shirt"). Three or more = we're hedging across genuinely
 * different families, which a single-word query cannot disambiguate.
 */
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
  /**
   * Optional post-cleanup input the user actually classified on. When
   * passed, the gate additionally refuses single-token inputs whose
   * retrieval window spans 3+ chapters — see "thin-input refinement"
   * in the file header. Omitted (or empty) means the check is skipped,
   * which preserves backwards compatibility for /expand and /boost
   * paths that don't pass effective text in.
   */
  effectiveDescription?: string,
): GateOutcome {
  if (candidates.length === 0) {
    return { passed: false, reason: 'invalid_prefix', topRetrievalScore: 0, top2Gap: 0 };
  }
  const top = candidates[0]!.rrf_score;
  const second = candidates[1]?.rrf_score ?? 0;
  const gap = top - second;

  // Thin-input + cross-chapter-spread refusal. This fires BEFORE the
  // score / gap checks because retrieval can produce a high top score
  // and a real top1-vs-top2 gap on a thin input by purely lexical means
  // (e.g. "books" lights up "In book form" under maps with rrf=1.0).
  // The check guards against false-confident outputs on inputs the
  // system genuinely cannot disambiguate.
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
    // Narrow-family escape hatch: when the close cluster is all in one
    // heading family, this is "picker, decide between siblings" — not
    // "we have no idea what this is." The HS heading (4-digit prefix) is
    // the right granularity for the family check: chapter (2-digit) is
    // too broad (would let "olive oil" cluster with "live animals" if
    // both started with 0-1 chapters), HS-6 is too tight (would split
    // 1509.20 + 1509.30 + 1509.40 even though they're all olive oil).
    //
    // Family signal we trust: the TOP TWO candidates share a heading.
    // The gap < MIN_GAP threshold by definition means top-1 and top-2
    // are statistically tied — that's the actual ambiguity we're being
    // asked to resolve. If they share a heading, the picker can pick
    // between them confidently. Top-3+ is irrelevant: the picker sees
    // top-8 anyway and the rest is just context.
    //
    // (Earlier we required top-3 to all share a heading, which was too
    // strict — "face mask" had top-1 and top-2 both at heading 4818 but
    // top-3 at 6307, so the strict version refused even though the
    // picker was perfectly able to choose between the 4818 pair.)
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
    // Falls through to passed=true. The picker will choose between the
    // tied top pair; this is exactly the case it was designed for.
  }

  return { passed: true, topRetrievalScore: top, top2Gap: gap };
}
