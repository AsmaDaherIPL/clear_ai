/**
 * Deterministic conflict-type classifier (PR 6).
 *
 * Runs BEFORE the reconciliation LLM and determines which of six conflict
 * types describes the (Track A annotated_candidates, Track B resolved_code +
 * subtree consistency_verdict) state. The classification drives the rest of
 * reconciliation:
 *
 *   ZERO_SIGNAL          → escalate to HITL (only escalation path)
 *   AGREEMENT            → accept, HIGH confidence, no audit
 *   DRIFT                → LLM picks within shared heading; mandatory audit
 *   AMBIGUOUS_MATERIAL   → accept code_resolver at LOW; sampled audit
 *   SPARSE_DESCRIPTION   → accept code_resolver at LOW; sampled audit
 *   CONTRADICTION        → override merchant code; Track A rank-1 wins;
 *                          mandatory audit
 *
 * No LLM. No DB. Pure function over the upstream pipeline state.
 */
import type {
  TrackAResult,
  TrackBResult,
  ConflictType,
  AnnotatedCandidate,
} from '../shared/pipeline.types.js';

/** First two digits of an HS code; the chapter level. */
function chapter(code: string | null | undefined): string | null {
  if (!code || code.length < 2) return null;
  return code.slice(0, 2);
}

/** First four digits of an HS code; the heading level. */
function heading(code: string | null | undefined): string | null {
  if (!code || code.length < 4) return null;
  return code.slice(0, 4);
}

/** Top fits/partial candidate from Track A. Prefers `fits` over `partial`. */
function topFitOrPartial(candidates: AnnotatedCandidate[]): AnnotatedCandidate | null {
  return (
    candidates.find((c) => c.fit === 'fits') ??
    candidates.find((c) => c.fit === 'partial') ??
    null
  );
}

/** Has Track A produced any candidate with a positive fit? */
function trackAHasSignal(trackA: TrackAResult): boolean {
  return trackA.annotated_candidates.some((c) => c.fit === 'fits' || c.fit === 'partial');
}

/**
 * Classify the (Track A, Track B) state into one of the six conflict types.
 *
 * Precedence is critical — the classifier returns the FIRST matching rule
 * in this order:
 *
 *   1. ZERO_SIGNAL          (both tracks empty)
 *   2. CONTRADICTION        (Track B says description disagrees at chapter level)
 *   3. AGREEMENT            (resolver code is in Track A's fits set,
 *                            OR single_a top is fits)
 *   4. DRIFT                (heading-level agreement, leaf-level disagreement)
 *   5. SPARSE_DESCRIPTION   (Track A no_fit / threshold_failed, Track B has code)
 *   6. AMBIGUOUS_MATERIAL   (default fall-through: signals exist but no positive
 *                            corroboration)
 *
 * Each rule is exclusive — a state can satisfy multiple, but earlier rules
 * win. Rationale per type:
 *
 *   ZERO_SIGNAL is checked first because it short-circuits — no point asking
 *   "is this a contradiction?" when there's nothing to contradict.
 *
 *   CONTRADICTION beats AGREEMENT because trackB.consistency_verdict
 *   ='contradicts' means the description pulls toward a different chapter
 *   entirely — even if Track A happens to share the resolver's code, the
 *   subtree retrieval already flagged a chapter mismatch.
 *
 *   AGREEMENT beats DRIFT because if the resolver's exact code is in the
 *   fits set, there's no leaf dispute to resolve.
 *
 *   DRIFT beats SPARSE/AMBIGUOUS because heading-level agreement is a
 *   stronger signal than absence of signal.
 *
 *   SPARSE beats AMBIGUOUS because "Track A retrieval was uninformative"
 *   is a different (operationally cleaner) story than "Track A produced
 *   candidates but none corroborated".
 */
export function classifyConflict(trackA: TrackAResult, trackB: TrackBResult): ConflictType {
  const aHas = trackAHasSignal(trackA);
  const bHas = !!trackB.resolved_code;

  // 1. ZERO_SIGNAL — neither track has anything we can act on
  if (!aHas && !bHas) {
    return 'ZERO_SIGNAL';
  }

  // 2. CONTRADICTION — Track B subtree retrieval says the description
  //    pulled toward a different chapter than the merchant claimed.
  //
  //    GUARD (PR 6.1): when Track A has NO fits AND NO partial candidates,
  //    the description-side signal is unreliable — the picker rejected
  //    every retrieved candidate, OR retrieval itself produced garbage
  //    (common on Arabic apparel, weak descriptions, etc). Promoting
  //    that hallucinated signal to "CONTRADICTION wins, Track A rank-1
  //    overrides merchant code" is worse than yesterday's
  //    override-passthrough behavior.
  //
  //    Demote to SPARSE_DESCRIPTION (resolver carries the row) or
  //    ZERO_SIGNAL (nothing to act on) when Track A is empty of positive
  //    signal. Only trust CONTRADICTION when Track A has at least one
  //    positive candidate AND PR 5's subtree retrieval flagged a
  //    cross-chapter mismatch — both signals together.
  if (trackB.consistency_verdict === 'contradicts' && aHas) {
    return 'CONTRADICTION';
  }

  // 2b. CONTRADICTION (chapter-level cross-track) — Track A's strongest
  //     positive candidate sits in a different chapter than the resolver code.
  //     Same guard: Track A must have positive signal for this to fire.
  if (aHas && bHas) {
    const top = topFitOrPartial(trackA.annotated_candidates);
    const aCh = chapter(top?.code);
    const bCh = chapter(trackB.resolved_code);
    if (top?.fit === 'fits' && aCh && bCh && aCh !== bCh) {
      return 'CONTRADICTION';
    }
  }

  // 3. AGREEMENT — resolver code is in Track A's fits set
  if (bHas) {
    const resolverInA = trackA.annotated_candidates.find((c) => c.code === trackB.resolved_code);
    if (resolverInA?.fit === 'fits') {
      return 'AGREEMENT';
    }
  }
  // 3b. AGREEMENT — single_a path with a fits candidate (no resolver to dispute)
  if (aHas && !bHas) {
    const top = topFitOrPartial(trackA.annotated_candidates);
    if (top?.fit === 'fits') {
      return 'AGREEMENT';
    }
  }

  // 4. DRIFT — both tracks have a code, headings match, but leaves disagree
  if (aHas && bHas) {
    const top = topFitOrPartial(trackA.annotated_candidates);
    const aHd = heading(top?.code);
    const bHd = heading(trackB.resolved_code);
    if (aHd && bHd && aHd === bHd && top?.code !== trackB.resolved_code) {
      return 'DRIFT';
    }
  }

  // 5. SPARSE_DESCRIPTION — Track A retrieval was uninformative; Track B
  //    is carrying the row alone
  if (bHas && (trackA.threshold_failed || trackA.no_fit)) {
    return 'SPARSE_DESCRIPTION';
  }

  // 6. AMBIGUOUS_MATERIAL — default fall-through. Signals exist on both
  //    sides (or just B) but no positive corroboration. The merchant code
  //    is plausible but unconfirmed. Per the canonical outcome map, this
  //    is the "merchant wins by default at LOW + sampled audit" path.
  return 'AMBIGUOUS_MATERIAL';
}
