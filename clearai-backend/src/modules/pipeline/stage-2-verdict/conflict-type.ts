/**
 * Deterministic conflict-type classifier.
 *
 * Runs BEFORE the reconciliation LLM and determines which conflict
 * type describes the (Track A annotated_candidates, Track B resolved_code +
 * subtree consistency_verdict) state. The classification drives the rest of
 * reconciliation:
 *
 *   ZERO_SIGNAL    → escalate to HITL (only escalation path)
 *   AGREEMENT      → accept, HIGH confidence
 *   DRIFT          → LLM picks within shared heading
 *   AMBIGUOUS      → accept code_resolver at LOW (collapses the legacy
 *                    AMBIGUOUS_MATERIAL + SPARSE_DESCRIPTION cases — both
 *                    had identical handler behavior)
 *   CONTRADICTION  → override merchant code; Track A rank-1 wins
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
 *   2. CONTRADICTION        (any of:
 *                            2a. Track B's PR 5 subtree retrieval flagged
 *                                an unanchored top-1 outside the merchant
 *                                heading (consistency_verdict='contradicts');
 *                            2b. Track A's top fit is in a different CHAPTER
 *                                than the resolver code;
 *                            2c. Track A's top fit is in a different HEADING
 *                                than the resolver code AND the resolver
 *                                code is NOT itself `fits` in Track A
 *                                — asymmetric-confidence guard prevents
 *                                false CONTRADICTION on AGREEMENT-shaped
 *                                states)
 *   3. AGREEMENT            (resolver code is in Track A's fits set,
 *                            OR single_a top is fits)
 *   4. DRIFT                (heading-level agreement, leaf-level disagreement)
 *   5. AMBIGUOUS            (default fall-through: either Track A retrieval
 *                            uninformative, OR signals exist on both sides
 *                            but no positive corroboration. Resolver code
 *                            wins at LOW confidence either way.)
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
 *   DRIFT beats AMBIGUOUS because heading-level agreement is a
 *   stronger signal than absence of signal.
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
  //    Demote to AMBIGUOUS (resolver carries the row) or
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

  // 2c. CONTRADICTION (heading-level cross-track, asymmetric-confidence) —
  //     Track A's rank-1 fit is `fits` in a DIFFERENT HEADING than the
  //     resolver code, AND the resolver code is NOT itself in Track A's fits
  //     set. Two completely different product families inside the same
  //     chapter (e.g. 8517 telephone equipment vs 8518 audio equipment)
  //     should reconcile to CONTRADICTION, not collapse to AMBIGUOUS.
  //
  //     The asymmetric guard matters: if the resolver code is ALSO in Track
  //     A's fits set, that's AGREEMENT (rule 3) and we'll catch it below.
  //     If it's not, Track A is positively endorsing a different heading
  //     AND not endorsing the merchant heading — that's a real
  //     contradiction, just narrower than a chapter swap.
  //
  //     Effective on the headphones case (item 1 in run 019e11f2-...):
  //       Track A rank-1 fit  = 851762900009  (heading 8517, fits)
  //       Resolver code        = 851830900003  (heading 8518, partial in A)
  //       Pre-fix verdict      = AMBIGUOUS  (low confidence)
  //       Post-fix verdict     = CONTRADICTION       (medium confidence, A wins)
  if (aHas && bHas) {
    const top = topFitOrPartial(trackA.annotated_candidates);
    const aHd = heading(top?.code);
    const bHd = heading(trackB.resolved_code);
    if (top?.fit === 'fits' && aHd && bHd && aHd !== bHd) {
      const resolverInA = trackA.annotated_candidates.find(
        (c) => c.code === trackB.resolved_code,
      );
      if (resolverInA?.fit !== 'fits') {
        return 'CONTRADICTION';
      }
    }
  }

  // 3. AGREEMENT — resolver code is in Track A's fits set
  if (bHas) {
    const resolverInA = trackA.annotated_candidates.find((c) => c.code === trackB.resolved_code);
    if (resolverInA?.fit === 'fits') {
      return 'AGREEMENT';
    }
  }
  // 3b. AGREEMENT — single_a path with any positive candidate (no resolver
  //     to dispute). Both `fits` and `partial` count: Track A is the only
  //     signal we have, and the alternative is AMBIGUOUS which requires a
  //     resolver to fall back on. With no resolver, AMBIGUOUS has no answer
  //     to give — so when Track A has ANY positive signal, treat it as
  //     AGREEMENT and let the handler pick the top candidate as the result.
  //     (The handler distinguishes `fits` vs `partial` in its rationale
  //     string, so trace readers can still tell the two cases apart.)
  if (aHas && !bHas) {
    return 'AGREEMENT';
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

  // 5+6. AMBIGUOUS — either Track A retrieval was uninformative (used to be
  //      SPARSE_DESCRIPTION) OR signals exist on both sides but no positive
  //      corroboration (used to be AMBIGUOUS_MATERIAL). Both had identical
  //      handler behaviour — merchant code wins at LOW — so they collapse
  //      into one type with one handler.
  //
  //      Externally this is classification_status=DRIFT in V1; the rationale
  //      string still distinguishes the two sub-cases (description thin vs
  //      heading-constrained-attribute-missing) for forensic readability.
  return 'AMBIGUOUS';
}
