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
  DescriptionClassifierResult,
  CodeResolverResult,
  ConflictType,
  AnnotatedCandidate,
} from '../../shared/pipeline.types.js';

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

/**
 * "partial" is a legacy alias for "partial_family" (PR4 / Layer 2). Returns
 * true for either label so existing call sites keep working without
 * touching every comparison.
 */
function isPartialFamily(fit: AnnotatedCandidate['fit']): boolean {
  return fit === 'partial_family' || fit === 'partial';
}

/** Top fits/partial-family candidate from Track A. Prefers `fits`. */
function topFitOrPartial(candidates: AnnotatedCandidate[]): AnnotatedCandidate | null {
  return (
    candidates.find((c) => c.fit === 'fits') ??
    candidates.find((c) => isPartialFamily(c.fit)) ??
    null
  );
}

/**
 * Has Track A produced any candidate with a positive fit? `fits`,
 * `partial_family` (incl. legacy `partial`), and `chapter_adjacent` all
 * count — `chapter_adjacent` means "we recognised the family, just not in
 * this chapter", which is positive signal for reconciliation.
 */
function trackAHasSignal(trackA: DescriptionClassifierResult): boolean {
  return trackA.annotated_candidates.some(
    (c) => c.fit === 'fits' || isPartialFamily(c.fit) || c.fit === 'chapter_adjacent',
  );
}

/**
 * Top `chapter_adjacent` candidate, or null. Used by the new chapter-family
 * reconciliation rule (PR4) — when Track A says "I see a related family,
 * just not this chapter" AND Track B's resolved code lands in a chapter
 * the picker considered adjacent, that's a family agreement, not a
 * contradiction.
 */
function topChapterAdjacent(candidates: AnnotatedCandidate[]): AnnotatedCandidate | null {
  return candidates.find((c) => c.fit === 'chapter_adjacent') ?? null;
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
/**
 * Picker confidence threshold below which Track A loses the ability to
 * override a corroborated merchant code via CONTRADICTION. Tuned starting
 * value; expected to be re-tuned from audit_flag rate data after rollout.
 *
 * The threshold catches the row-135 class: 3-token descriptions ("TORY 45",
 * "RESY", "4 KNOTS SFIFA") where the picker confidently picks a wrong-
 * chapter leaf and Track A's CONTRADICTION rule overrides a correct
 * merchant code. With picker_confidence well under 0.30 in these cases and
 * the merchant code carrying a >=6-digit prefix hit, the gate fires and
 * the row routes through AMBIGUOUS (merchant wins at LOW).
 */
const PICKER_CONFIDENCE_GATE = 0.30;

/**
 * Minimum merchant-code prefix length that buys Track B the right to
 * override a low-confidence CONTRADICTION. 6 digits is HS6 (subheading),
 * the level at which the merchant has committed to a real product family
 * rather than just chapter intent.
 */
const MIN_RESOLVER_PREFIX_FOR_GATE = 6;

export function classifyConflict(trackA: DescriptionClassifierResult, trackB: CodeResolverResult): ConflictType {
  const aHas = trackAHasSignal(trackA);
  const bHas = !!trackB.resolved_code;

  // 1. ZERO_SIGNAL — neither track has anything we can act on
  if (!aHas && !bHas) {
    return 'ZERO_SIGNAL';
  }

  // 1a. LOW_CONFIDENCE_TRACK_A guard — when the picker is structurally
  //     uncertain (thin description, large leaf-space, or sparse fits) AND
  //     the merchant code carries at least an HS6 prefix hit, demote any
  //     CONTRADICTION outcome to AMBIGUOUS so the merchant code wins at
  //     LOW confidence rather than being overridden by a low-confidence
  //     picker pick.
  //
  //     The classic miss: "TORY 45" picker landed on petroleum Ch 27 with
  //     a confident-looking `fits`, merchant said 6404 (footwear).
  //     picker_confidence is well under 0.30 because (a) 3-token
  //     description triggers the thinness penalty and (b) Ch 27 has ~200
  //     leaves so the fan-out penalty discounts the score further.
  //     Pre-gate: CONTRADICTION → Track A's wrong-chapter pick wins.
  //     Post-gate: AMBIGUOUS → merchant 6404 wins; row is auditable.
  if (
    bHas &&
    trackA.picker_confidence !== null &&
    trackA.picker_confidence < PICKER_CONFIDENCE_GATE &&
    (trackB.valid_prefix?.length ?? 0) >= MIN_RESOLVER_PREFIX_FOR_GATE
  ) {
    return 'AMBIGUOUS';
  }

  // 1b. CHAPTER-FAMILY AGREEMENT — Track A explicitly marked a candidate
  //     `chapter_adjacent` AND Track B's resolved code lands in a chapter
  //     different from Track A's adjacent-marked candidate. The picker has
  //     stated "I see the same product family, just split across chapters
  //     by HS convention" — that's a family match, not a CONTRADICTION.
  //     Route to AGREEMENT so Track B's chapter-correct code wins.
  //
  //     Rescues row-23 (Babybjorn bouncer: Track A picked 6307 textile
  //     cradle as chapter_adjacent, merchant 9401 seats — same family),
  //     row-108 (Joolz cot: same shape), row-8 (GPU: Track A 8542 ICs as
  //     chapter_adjacent, merchant 8471 computer parts).
  //
  //     Guard: only fires when no `fits` candidate exists in the resolver's
  //     chapter — otherwise the normal AGREEMENT rule (3) handles it
  //     correctly and we don't want to short-circuit a clean fits.
  if (bHas) {
    const adjacent = topChapterAdjacent(trackA.annotated_candidates);
    const bCh = chapter(trackB.resolved_code);
    const aCh = chapter(adjacent?.code);
    if (adjacent && bCh && aCh && bCh !== aCh) {
      const hasFitsInResolverChapter = trackA.annotated_candidates.some(
        (c) => c.fit === 'fits' && chapter(c.code) === bCh,
      );
      if (!hasFitsInResolverChapter) {
        return 'AGREEMENT';
      }
    }
  }

  // 2. CONTRADICTION — Track B subtree retrieval says the description
  //    pulled toward a different chapter than the merchant claimed.
  //
  //    Confidence guard (2026-05-13): Track A must have at least one
  //    rank-1 `fits` candidate. A `partial`-only set means the picker is
  //    hedging on material/form-factor that the description doesn't
  //    constrain — not strong enough to override a merchant-supplied code.
  //    The classic miss: "magnetic building blocks" partial-fits chapter
  //    85 (magnets), merchant said 9503 (toys); promoting Track A's
  //    partial-8505 over the merchant's 9503 produced wrong codes.
  //
  //    Demote partial-only CONTRADICTION to AMBIGUOUS so the resolver
  //    carries the row at low confidence (the merchant's code stays
  //    visible in HITL for human review).
  if (trackB.consistency_verdict === 'contradicts' && aHas) {
    const topPositive = topFitOrPartial(trackA.annotated_candidates);
    if (topPositive?.fit === 'fits') {
      // Geomag-class guard (2026-05-13): when the chapter-coherence
      // pre-filter inferred a chapter from keyword signals AND the
      // merchant code is in those inferred chapters AND Track A's fits
      // candidate is in a DIFFERENT chapter, trust the merchant code.
      // The picker's `fits` is overconfident — retrieval gave it 12
      // wrong-chapter candidates because the catalog vocabulary clusters
      // the wrong way ("magnetic" → chapter 85 magnets, even when the
      // product is a toy in 95). Merchant code + cleanup-derived
      // chapter inference beat picker's vector-driven fits here.
      if (trackA.inferred_chapters.length > 0) {
        const bCh = chapter(trackB.resolved_code);
        const aCh = chapter(topPositive.code);
        const merchantAgreesWithInference = bCh !== null && trackA.inferred_chapters.includes(bCh);
        const trackAOutsideInference = aCh !== null && !trackA.inferred_chapters.includes(aCh);
        if (merchantAgreesWithInference && trackAOutsideInference) {
          return 'AMBIGUOUS';
        }
      }
      return 'CONTRADICTION';
    }
    // fall through to AMBIGUOUS via the default
  }

  // 2b. CONTRADICTION (chapter-level cross-track) — Track A's strongest
  //     positive candidate sits in a different chapter than the resolver code.
  //     Same guard: Track A must have positive signal for this to fire.
  if (aHas && bHas) {
    const top = topFitOrPartial(trackA.annotated_candidates);
    const aCh = chapter(top?.code);
    const bCh = chapter(trackB.resolved_code);
    if (top?.fit === 'fits' && aCh && bCh && aCh !== bCh) {
      // Geomag guard: prefer merchant code when it agrees with keyword inference.
      if (trackA.inferred_chapters.length > 0) {
        const merchantAgrees = trackA.inferred_chapters.includes(bCh);
        const trackAOutside = !trackA.inferred_chapters.includes(aCh);
        if (merchantAgrees && trackAOutside) {
          return 'AMBIGUOUS';
        }
      }
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
