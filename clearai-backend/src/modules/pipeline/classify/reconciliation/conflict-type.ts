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
 * Has Track A produced any candidate with a LEAF-LEVEL positive fit?
 *
 * `fits` and `partial_family` (incl. legacy `partial`) qualify — the
 * picker has endorsed a specific leaf as a possible final answer.
 *
 * `chapter_adjacent` does NOT qualify. It is family-level evidence —
 * "I see the family but the right chapter isn't this candidate's
 * chapter". Alone, without a merchant code to disambiguate which
 * chapter is correct, it produces no defensible final code. Rows in
 * this state must escalate (ZERO_SIGNAL), not route to AGREEMENT and
 * then crash in handleAgreement when it can't find a positive leaf.
 *
 * Fixed 2026-05-14 after PR4 incorrectly counted chapter_adjacent here,
 * causing row 17 (Noctua CPU Cooler, no merchant) to crash with
 * "AGREEMENT classified but no positive candidate found".
 */
function trackAHasSignal(trackA: DescriptionClassifierResult): boolean {
  return trackA.annotated_candidates.some(
    (c) => c.fit === 'fits' || isPartialFamily(c.fit),
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
 * Classify the (Track A, Track B) state into one of the conflict types.
 *
 * Precedence is critical — the classifier returns the FIRST matching rule.
 * Rules are evaluated in this order (post 2026-05-14 reorder):
 *
 *   1.  ZERO_SIGNAL          neither track has anything actionable.
 *                            Track A "has signal" requires LEAF-LEVEL fit
 *                            (fits or partial_family). chapter_adjacent
 *                            alone does NOT satisfy — it is family-level
 *                            evidence that requires a merchant code to
 *                            disambiguate the correct chapter.
 *
 *   1a. AGREEMENT (chapter-family)
 *                            Track A explicitly marked a candidate
 *                            `chapter_adjacent` AND merchant code is in
 *                            a DIFFERENT chapter than that candidate.
 *                            Three guards (all required):
 *                              G1. no leaf-level signal (fits or
 *                                  partial_family) in resolver chapter
 *                              G2. no `fits` anywhere in Track A. A leaf-
 *                                  level `fits` is the picker's strongest
 *                                  signal and must reach the leaf-based
 *                                  rules below (3 / 2b) regardless of
 *                                  which chapter it sits in
 *                              G3. trackB.consistency_verdict !== 'contradicts'
 *                            Merchant code wins. Source: code_resolver.
 *
 *   1b. AMBIGUOUS (confidence gate)
 *                            picker_confidence < PICKER_CONFIDENCE_GATE
 *                            AND merchant valid_prefix length >= 6.
 *                            Demotes what would otherwise be CONTRADICTION
 *                            to AMBIGUOUS so a low-confidence Track A
 *                            cannot override a corroborated merchant code.
 *
 *   2.  CONTRADICTION        Track B's PR 5 subtree retrieval flagged
 *                            consistency_verdict='contradicts' AND Track A
 *                            has at least one positive leaf signal.
 *                            Geomag guard: if Track A's pick disagrees
 *                            with cleanup's inferred_chapters AND merchant
 *                            agrees, demote to AMBIGUOUS.
 *
 *   2b. CONTRADICTION (chapter-cross)
 *                            Track A's top fit is in a different CHAPTER
 *                            than the resolver code (and was `fits`, not
 *                            partial). Same Geomag guard.
 *
 *   2c. CONTRADICTION (heading-cross, asymmetric)
 *                            Track A's top fit is in a different HEADING
 *                            than the resolver code AND the resolver code
 *                            is NOT itself `fits` in Track A.
 *
 *   3.  AGREEMENT (resolver-in-fits)
 *                            resolver code appears in Track A's fits set.
 *
 *   3b. AGREEMENT (single_a)
 *                            no resolver code AND Track A has any leaf-
 *                            level positive (fits or partial_family).
 *
 *   4.  DRIFT                both tracks have a code, same heading, but
 *                            different leaves. LLM-resolved.
 *
 *   5/6.AMBIGUOUS (fall-through)
 *                            default terminal. Merchant code wins at LOW
 *                            confidence when present; escalates otherwise.
 *
 * Precedence rationale:
 *
 *   - ZERO_SIGNAL first: short-circuits, no point asking "is this a
 *     contradiction?" when there's nothing to contradict.
 *
 *   - Chapter-family AGREEMENT (1a) BEFORE the confidence gate (1b)
 *     because the picker's explicit family endorsement is *evidence*,
 *     not low-confidence noise. Pre-reorder: row 8 (GPU) was demoted
 *     to AMBIGUOUS LOW even though Track A clearly identified the
 *     computer-stack family.
 *
 *   - Chapter-family AGREEMENT (1a) ALSO before CONTRADICTION (2) for
 *     the narrow case where Track A picked candidates in a chapter
 *     adjacent to the merchant's. This INVERTS the older "CONTRADICTION
 *     beats AGREEMENT" rule — guard G3 ensures the inversion only
 *     applies when Track B's own subtree retrieval has not already
 *     declared its own merchant code self-inconsistent.
 *
 *   - CONTRADICTION (2/2b/2c) beats AGREEMENT (3) for non-family cases:
 *     if trackB.consistency_verdict='contradicts' the description pulls
 *     toward a different chapter entirely.
 *
 *   - AGREEMENT (3) beats DRIFT (4): if resolver code is in fits set,
 *     no leaf dispute to resolve.
 *
 *   - DRIFT (4) beats AMBIGUOUS (5/6): heading-level agreement is a
 *     stronger signal than absence of signal.
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
  const aHasLeaf = trackAHasSignal(trackA);
  const bHas = !!trackB.resolved_code;

  // 1. ZERO_SIGNAL — Track A has no LEAF-LEVEL fit AND Track B has no
  //    merchant code. Family-only signal (chapter_adjacent) alone is
  //    not actionable without a merchant code to disambiguate the
  //    correct chapter — covered by this same branch because
  //    trackAHasSignal returns false for family-only Track A
  //    (chapter_adjacent does not satisfy "has signal").
  //
  //    Without this gate, a chapter_adjacent-only Track A + no merchant
  //    would route to AGREEMENT and handleAgreement would crash trying
  //    to find a positive leaf — bug fixed 2026-05-14 (row 17 Noctua
  //    CPU Cooler).
  if (!aHasLeaf && !bHas) {
    return 'ZERO_SIGNAL';
  }

  // 1a. CHAPTER-FAMILY AGREEMENT — Track A explicitly marked a candidate
  //     `chapter_adjacent` AND Track B's resolved code lands in a chapter
  //     different from Track A's adjacent-marked candidate. The picker has
  //     stated "I see the same product family, just split across chapters
  //     by HS convention" — that's a family match, not a CONTRADICTION
  //     and not an AMBIGUOUS LOW.
  //
  //     This rule runs BEFORE the low-confidence gate (1b) because the
  //     picker's explicit family endorsement is *evidence*, not noise.
  //     The original ordering (gate first, family rule second) caused
  //     row 8 (GPU graphics card) to be demoted to AMBIGUOUS LOW even
  //     though Track A had clearly identified the computer-stack family.
  //     Reordered 2026-05-14.
  //
  //     Rescues row 8 (GPU: Track A Ch 85 monitors/ICs as
  //     chapter_adjacent, merchant Ch 84 computer parts), row 23
  //     (Babybjorn: Ch 63 textile cradle ↔ Ch 94 seats), row 108
  //     (Joolz cot: same shape).
  //
  //     Three guards (all required, added 2026-05-14 v2 after peer review):
  //
  //     G1. NO leaf-level signal exists in the resolver's chapter
  //         (neither `fits` nor `partial_family`). If Track A has a leaf
  //         endorsement in the resolver's chapter, AGREEMENT/AMBIGUOUS
  //         rules below handle it — family-level signal must not
  //         short-circuit a leaf-level one.
  //
  //     G2. NO leaf-level `fits` exists ANYWHERE in Track A (not just
  //         in other chapters). A `fits` is the picker's strongest
  //         signal — it endorses a specific leaf as the answer.
  //         Family-level evidence (`chapter_adjacent`) must NEVER bury
  //         a leaf-level endorsement, regardless of which chapter the
  //         fits sits in. Known limitation: this is binary and unscored,
  //         so a low-score `fits` (e.g. rrf 0.05 RAG noise) inhibits 1a
  //         the same as a high-score one. If audit shows legitimate
  //         chapter-family rows being demoted by junk-tier fits, tier-
  //         gate on rrf_score or fits-count. Documented 2026-05-14 v2.
  //
  //     G3. Track B's consistency_verdict is NOT 'contradicts'. Track B's
  //         own subtree retrieval saying "my description doesn't pull
  //         toward my own chapter" already disqualifies the merchant
  //         code from carrying AGREEMENT. Track A's family signal must
  //         not rescue a self-contradicting merchant code.
  if (bHas && trackB.consistency_verdict !== 'contradicts') {
    const adjacent = topChapterAdjacent(trackA.annotated_candidates);
    if (adjacent) {
      const bCh = chapter(trackB.resolved_code);
      const aCh = chapter(adjacent.code);
      if (bCh && aCh && bCh !== aCh) {
        // G1: no leaf signal in the resolver's chapter.
        const hasLeafInResolverChapter = trackA.annotated_candidates.some(
          (c) =>
            (c.fit === 'fits' || isPartialFamily(c.fit)) && chapter(c.code) === bCh,
        );
        // G2: no `fits` anywhere else. partial_family elsewhere does NOT
        //     block 1a — partial is a hedge, not a confident endorsement.
        //     A leaf fits in any chapter is the picker's strongest signal
        //     and beats family-level evidence.
        const hasFitsAnyChapter = trackA.annotated_candidates.some(
          (c) => c.fit === 'fits',
        );
        if (!hasLeafInResolverChapter && !hasFitsAnyChapter) {
          return 'AGREEMENT';
        }
      }
    }
  }

  // 1b. LOW_CONFIDENCE_TRACK_A guard — when the picker is structurally
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
  //
  //     Runs AFTER chapter-family (1a) so the picker's explicit family
  //     endorsement isn't drowned by a low-confidence number.
  if (
    bHas &&
    trackA.picker_confidence !== null &&
    trackA.picker_confidence < PICKER_CONFIDENCE_GATE &&
    trackB.valid_prefix !== null &&
    trackB.valid_prefix.length >= MIN_RESOLVER_PREFIX_FOR_GATE
  ) {
    return 'AMBIGUOUS';
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
  if (trackB.consistency_verdict === 'contradicts' && aHasLeaf) {
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
  if (aHasLeaf && bHas) {
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
  if (aHasLeaf && bHas) {
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
  if (aHasLeaf && !bHas) {
    return 'AGREEMENT';
  }

  // 4. DRIFT — both tracks have a code, headings match, but leaves disagree
  if (aHasLeaf && bHas) {
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
