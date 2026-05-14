/**
 * Reconciliation outcome map.
 *
 * Each internal conflict type maps to a specific (decision, source,
 * classification_status) tuple. These tests pin those tuples so a future
 * regression is loud.
 *
 *   AGREEMENT          → accept, classification_status=AGREEMENT
 *   DRIFT              → accept, classification_status=DRIFT
 *   AMBIGUOUS          → accept, classification_status=DRIFT
 *   CONTRADICTION      → accept, classification_status=DRIFT
 *                        (Track A rank-1 wins; merchant code overridden)
 *   ZERO_SIGNAL        → escalate
 *
 * The DRIFT path involves the LLM, which we mock. Other paths are
 * deterministic. confidence_band was removed in 0072_drop_confidence_band;
 * classification_status is the single external surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classificationStatusFromConflictType,
  type DescriptionClassifierResult,
  type CodeResolverResult,
  type AnnotatedCandidate,
  type CandidateFitVerdict,
  type ConsistencyVerdict,
  type VerdictResult,
} from '../../src/modules/pipeline/shared/pipeline.types.js';

const structuredLlmCallMock = vi.fn();
vi.mock('../../src/inference/llm/structured-call.js', () => ({
  structuredLlmCall: (...args: unknown[]) => structuredLlmCallMock(...args),
  loadPrompt: vi.fn().mockResolvedValue('mock-prompt'),
}));

import { runReconciliation } from '../../src/modules/pipeline/classify/reconciliation/reconciliation.js';

function ac(code: string, fit: CandidateFitVerdict, rrf = 0.05, rationale = 'test'): AnnotatedCandidate {
  return { code, description_en: code, description_ar: null, rrf_score: rrf, fit, rationale };
}

function trackA(opts: {
  candidates?: AnnotatedCandidate[];
  no_fit?: boolean;
  threshold_failed?: boolean;
  picker_confidence?: number | null;
}): DescriptionClassifierResult {
  const cands = opts.candidates ?? [];
  // no_fit means "picker found nothing the description sits in". Under the
  // PR4 taxonomy, that's true iff there is no `fits`, no `partial_family`,
  // and no legacy `partial`. chapter_adjacent on its own does NOT defeat
  // no_fit — it's a family hint, not a leaf endorsement.
  const hasLeafFit = cands.some(
    (c) => c.fit === 'fits' || c.fit === 'partial_family' || c.fit === 'partial',
  );
  return {
    annotated_candidates: cands,
    threshold_failed: opts.threshold_failed ?? false,
    no_fit: opts.no_fit ?? !hasLeafFit,
    interpretation_stage: 'cleaned',
    effective_description: 'test',
    research: null,
    web_research: null,
    inferred_chapters: [],
    prefilter_aborted: false,
    picker_confidence: opts.picker_confidence ?? null,
  };
}

function trackB(opts: {
  resolved_code?: string | null;
  consistency_verdict?: ConsistencyVerdict;
  override_applied?: boolean;
  subtree_top_code?: string;
}): CodeResolverResult {
  return {
    resolved_code: opts.resolved_code ?? null,
    resolution: opts.resolved_code ? 'passthrough' : 'null_resolution',
    raw_merchant_code: opts.resolved_code,
    codebook_state: opts.resolved_code ? 'active' : 'not_applicable',
    override_applied: opts.override_applied ?? false,
    override_target_code: null,
    consistency_verdict: opts.consistency_verdict ?? 'consistent',
    valid_prefix: opts.resolved_code?.slice(0, 6) ?? null,
    subtree_candidates: opts.subtree_top_code
      ? [
          {
            code: opts.subtree_top_code,
            description_en: opts.subtree_top_code,
            description_ar: null,
            rrf_score: 0.05,
            fit: 'fits',
            rationale: 'forced from unanchored top-1',
          },
        ]
      : [],
  };
}

beforeEach(() => {
  structuredLlmCallMock.mockReset();
});

describe('runReconciliation — outcome map per conflict type', () => {
  // ──────────────────────────────────────────────────────────
  // AGREEMENT
  // ──────────────────────────────────────────────────────────
  it('AGREEMENT (resolver in fits): accept, source=code_resolver', async () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'wireless headphones')) as VerdictResult;
    expect(v.decision).toBe('accept');
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.source).toBe('code_resolver');
    expect(v.final_code).toBe('851830900003');
  });

  it('AGREEMENT (single_a fits): accept, source=description_classifier', async () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({}); // no resolved_code
    const v = (await runReconciliation(a, b, 'wireless headphones')) as VerdictResult;
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.source).toBe('description_classifier');
  });

  it('AGREEMENT (single_a partial-only, no resolver): accept top partial, rationale notes "partial fit"', async () => {
    // Regression for "Jackets" with no merchant code where the picker
    // labels every candidate `partial` (every leaf constrains
    // gender/material). Pre-fix: fell through to AMBIGUOUS handler which
    // threw because there was no resolved_code. Post-fix: accept the top
    // partial as the answer.
    const a = trackA({
      candidates: [
        ac('610330000000', 'partial', 0.039, 'jackets without material confirmation'),
        ac('620100000000', 'partial', 0.038, 'outer jackets without confirmation'),
      ],
    });
    const b = trackB({}); // no resolved_code
    const v = (await runReconciliation(a, b, 'Jackets')) as VerdictResult;
    expect(v.decision).toBe('accept');
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.source).toBe('description_classifier');
    expect(v.final_code).toBe('610330000000');
    expect(v.rationale).toMatch(/partial fit/i);
  });

  // ──────────────────────────────────────────────────────────
  // CONTRADICTION — Track A rank-1 wins
  // ──────────────────────────────────────────────────────────
  it('CONTRADICTION (consistency_verdict=contradicts): accept, Track A rank-1 wins', async () => {
    const a = trackA({ candidates: [ac('460200000000', 'fits')] });
    const b = trackB({ resolved_code: '630790300000', consistency_verdict: 'contradicts' });
    const v = (await runReconciliation(a, b, 'storage basket')) as VerdictResult;
    expect(v.conflict_type).toBe('CONTRADICTION');
    expect(v.final_code).toBe('460200000000');
    expect(v.source).toBe('description_classifier');
  });

  it('PR 6.1: when consistency_verdict=contradicts BUT Track A has no fits/partial, demotes to AMBIGUOUS (no longer CONTRADICTION)', async () => {
    // Pre-PR-6.1 this case promoted the unanchored top-1 (subtree_candidates[0])
    // to the answer, even though Track A's retrieval was hallucinating. The
    // hoodie case (2026-05-10) showed that's worse than passing the override
    // through. Now: Track A signal is unreliable → AMBIGUOUS, resolver
    // carries the row.
    const a = trackA({ candidates: [ac('630790300000', 'does_not_fit')] });
    const b = trackB({
      resolved_code: '630790300000',
      consistency_verdict: 'contradicts',
      subtree_top_code: '460200000000',
    });
    const v = (await runReconciliation(a, b, 'storage basket')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.final_code).toBe('630790300000'); // resolver code, not the hallucinated unanchored top
  });

  // ──────────────────────────────────────────────────────────
  // AMBIGUOUS — source=code_resolver
  // ──────────────────────────────────────────────────────────
  it('AMBIGUOUS (material-only): accept, source=code_resolver', async () => {
    // Track A produces a partial in a different heading; Track B has
    // a resolved code. No fits, no chapter mismatch on a fits, no DRIFT
    // (headings differ), description-thin case.
    const a = trackA({ candidates: [ac('851712000000', 'partial')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'some audio device')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.source).toBe('code_resolver');
    expect(v.final_code).toBe('851830900003');
  });

  // ──────────────────────────────────────────────────────────
  // AMBIGUOUS — sparse description
  // ──────────────────────────────────────────────────────────
  it('AMBIGUOUS (no_fit, sparse description): accept', async () => {
    const a = trackA({ no_fit: true });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'thin description')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.source).toBe('code_resolver');
  });

  it('AMBIGUOUS (threshold_failed, sparse description): accept', async () => {
    const a = trackA({ threshold_failed: true });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'thin description')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
  });

  // ──────────────────────────────────────────────────────────
  // ZERO_SIGNAL → escalate
  // ──────────────────────────────────────────────────────────
  it('ZERO_SIGNAL: escalate', async () => {
    const a = trackA({});
    const b = trackB({});
    const v = await runReconciliation(a, b, 'whatever');
    expect(v.decision).toBe('escalate');
    if (v.decision === 'escalate') {
      expect(v.conflict_type).toBe('ZERO_SIGNAL');
      expect(v.disagreement_summary).toMatch(/ZERO_SIGNAL/);
    }
  });

  // ──────────────────────────────────────────────────────────
  // DRIFT — LLM call. Verify the outcome map for both LLM success
  // and LLM failure paths.
  // ──────────────────────────────────────────────────────────
  it('DRIFT (LLM picks a leaf): accept', async () => {
    structuredLlmCallMock.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        decision: 'accept',
        final_code: '620463000004',
        source: 'reconciled',
        rationale: 'tight leggings of synthetic fibres match bootcut legging form',
      },
      trace: {},
    });
    const a = trackA({ candidates: [ac('620463000004', 'partial')] });
    const b = trackB({ resolved_code: '620463000000' });
    const v = (await runReconciliation(a, b, 'bootcut legging')) as VerdictResult;
    expect(v.conflict_type).toBe('DRIFT');
    expect(v.final_code).toBe('620463000004');
  });

  it('DRIFT (LLM unavailable, resolver code present): falls through to code_resolver', async () => {
    structuredLlmCallMock.mockResolvedValueOnce({
      kind: 'llm_failed',
      error: 'HTTP 503',
      trace: {},
    });
    const a = trackA({ candidates: [ac('620463000004', 'partial')] });
    const b = trackB({ resolved_code: '620463000000' });
    const v = (await runReconciliation(a, b, 'bootcut legging')) as VerdictResult;
    // LLM-failure-during-DRIFT falls back to resolver code.
    expect(v.conflict_type).toBe('DRIFT');
    expect(v.final_code).toBe('620463000000');
  });

  it('DRIFT (LLM returns code outside allowed set): escalates as ZERO_SIGNAL', async () => {
    structuredLlmCallMock.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        decision: 'accept',
        final_code: '999999999999', // not in candidates or resolver
        source: 'reconciled',
        rationale: 'hallucinated code',
      },
      trace: {},
    });
    const a = trackA({ candidates: [ac('620463000004', 'partial')] });
    const b = trackB({ resolved_code: '620463000000' });
    const v = await runReconciliation(a, b, 'bootcut legging');
    expect(v.decision).toBe('escalate');
    if (v.decision === 'escalate') {
      expect(v.conflict_type).toBe('ZERO_SIGNAL');
      expect(v.disagreement_summary).toMatch(/not in the allowed set/);
    }
  });
});

/**
 * V1 surface: classification_status (AGREEMENT | DRIFT | ZERO_SIGNAL).
 *
 * The internal 6-way conflict_type taxonomy is preserved for accuracy of
 * the per-case dispatch (CONTRADICTION still routes to Track A rank-1,
 * AMBIGUOUS_MATERIAL still falls through to merchant code, etc.) — see the
 * tests above. These tests pin the EXTERNAL collapse:
 *   AGREEMENT          → AGREEMENT
 *   DRIFT              → DRIFT
 *   CONTRADICTION      → DRIFT     (was its own bucket; rolled into DRIFT)
 *   AMBIGUOUS_MATERIAL → DRIFT     (was its own bucket; rolled into DRIFT)
 *   SPARSE_DESCRIPTION → DRIFT     (was its own bucket; rolled into DRIFT)
 *   ZERO_SIGNAL        → ZERO_SIGNAL
 *
 * If any of these mappings drift, the V1 SPA breaks. Pin them loudly.
 */
describe('runReconciliation — V1 classification_status surface collapse', () => {
  it('AGREEMENT (resolver in fits) → classification_status = AGREEMENT', async () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'wireless headphones')) as VerdictResult;
    expect(v.classification_status).toBe('AGREEMENT');
  });

  it('AGREEMENT (single_a fits) → classification_status = AGREEMENT', async () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({});
    const v = (await runReconciliation(a, b, 'wireless headphones')) as VerdictResult;
    expect(v.classification_status).toBe('AGREEMENT');
  });

  it('CONTRADICTION (PR 5 contradicts) → classification_status = DRIFT', async () => {
    const a = trackA({ candidates: [ac('460200000000', 'fits')] });
    const b = trackB({ resolved_code: '630790300000', consistency_verdict: 'contradicts' });
    const v = (await runReconciliation(a, b, 'storage basket')) as VerdictResult;
    expect(v.classification_status).toBe('DRIFT');
    expect(v.conflict_type).toBe('CONTRADICTION'); // internal preserved
  });

  it('AMBIGUOUS_MATERIAL → classification_status = DRIFT', async () => {
    const a = trackA({ candidates: [ac('851712000000', 'partial')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'some audio device')) as VerdictResult;
    expect(v.classification_status).toBe('DRIFT');
    expect(v.conflict_type).toBe('AMBIGUOUS');
  });

  it('SPARSE_DESCRIPTION (no_fit) → classification_status = DRIFT', async () => {
    const a = trackA({ no_fit: true });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'thin description')) as VerdictResult;
    expect(v.classification_status).toBe('DRIFT');
    expect(v.conflict_type).toBe('AMBIGUOUS');
  });

  it('DRIFT (LLM picks) → classification_status = DRIFT', async () => {
    structuredLlmCallMock.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        decision: 'accept',
        final_code: '620463000004',
        source: 'reconciled',
        rationale: 'pick',
      },
      trace: {},
    });
    const a = trackA({ candidates: [ac('620463000004', 'partial')] });
    const b = trackB({ resolved_code: '620463000000' });
    const v = (await runReconciliation(a, b, 'bootcut legging')) as VerdictResult;
    expect(v.classification_status).toBe('DRIFT');
    expect(v.conflict_type).toBe('DRIFT');
  });

  it('DRIFT (LLM unavailable, resolver fallback) → classification_status = DRIFT', async () => {
    structuredLlmCallMock.mockResolvedValueOnce({ kind: 'llm_failed', error: '503', trace: {} });
    const a = trackA({ candidates: [ac('620463000004', 'partial')] });
    const b = trackB({ resolved_code: '620463000000' });
    const v = (await runReconciliation(a, b, 'bootcut legging')) as VerdictResult;
    expect(v.classification_status).toBe('DRIFT');
  });

  it('ZERO_SIGNAL → classification_status = ZERO_SIGNAL on escalate', async () => {
    const a = trackA({});
    const b = trackB({});
    const v = await runReconciliation(a, b, 'whatever');
    expect(v.decision).toBe('escalate');
    if (v.decision === 'escalate') {
      expect(v.classification_status).toBe('ZERO_SIGNAL');
    }
  });

  it('AMBIGUOUS (converging): Track A partial code == Track B resolved → rationale flags convergence', async () => {
    // Pinned scenario: run 019e15e6-... item 4 (Bootcut Legging).
    // Track A rank-1 partial = 620463000004 (description silent on material).
    // Track B's llm_pick_under_prefix also resolves to 620463000004.
    // Both tracks converge on the same leaf despite the partial label —
    // rationale string distinguishes this case for trace readers.
    const a = trackA({ candidates: [ac('620463000004', 'partial')] });
    const b = trackB({ resolved_code: '620463000004' });
    const v = (await runReconciliation(a, b, 'bootcut legging')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.final_code).toBe('620463000004');
    expect(v.rationale).toMatch(/converging/i);
  });

  it('AMBIGUOUS (non-converging): Track A partial in DIFFERENT code → rationale omits convergence', async () => {
    const a = trackA({ candidates: [ac('851712000000', 'partial')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'some audio device')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.rationale).not.toMatch(/converging/i);
  });

  it('classificationStatusFromConflictType: pure mapping function pins V1 collapse', () => {
    // This is the canonical mapping that the SQL fallback in
    // declaration-run.controller.ts mirrors for legacy rows persisted
    // before classification_status existed in the trace JSON. If these
    // mappings drift, that SQL fallback's CASE statement drifts too.
    expect(classificationStatusFromConflictType('AGREEMENT')).toBe('AGREEMENT');
    expect(classificationStatusFromConflictType('ZERO_SIGNAL')).toBe('ZERO_SIGNAL');
    expect(classificationStatusFromConflictType('DRIFT')).toBe('DRIFT');
    expect(classificationStatusFromConflictType('CONTRADICTION')).toBe('DRIFT');
    expect(classificationStatusFromConflictType('AMBIGUOUS_MATERIAL')).toBe('DRIFT');
    expect(classificationStatusFromConflictType('SPARSE_DESCRIPTION')).toBe('DRIFT');
  });

  it('DRIFT LLM hallucination → escalates as ZERO_SIGNAL', async () => {
    structuredLlmCallMock.mockResolvedValueOnce({
      kind: 'ok',
      data: { decision: 'accept', final_code: '999999999999', source: 'reconciled', rationale: 'bad' },
      trace: {},
    });
    const a = trackA({ candidates: [ac('620463000004', 'partial')] });
    const b = trackB({ resolved_code: '620463000000' });
    const v = await runReconciliation(a, b, 'bootcut legging');
    expect(v.decision).toBe('escalate');
    if (v.decision === 'escalate') {
      expect(v.classification_status).toBe('ZERO_SIGNAL');
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // PR1.1 + PR4.1 — chapter_adjacent precedence and single-track safety
  //
  // Two production bugs surfaced in the 2026-05-14 batch (150 rows):
  //
  //   1. Row 17 (Noctua CPU Cooler, no merchant code) CRASHED with
  //      "AGREEMENT classified but no positive candidate found". Root
  //      cause: PR4 made `chapter_adjacent` count as positive signal in
  //      trackAHasSignal(), so an adjacent-only Track A routed to
  //      AGREEMENT. handleAgreement's Path 2 (single_a, no merchant)
  //      called topFitCandidate() which doesn't look at chapter_adjacent
  //      → null → throw.
  //
  //   2. Row 8 (GPU graphics card, merchant 8471804000): PR4's
  //      chapter-family AGREEMENT rule should have fired (Track A marked
  //      Ch 8528 monitors / Ch 8542 ICs as chapter_adjacent, merchant in
  //      Ch 8471). Instead the PR1 confidence gate fired FIRST and
  //      demoted to AMBIGUOUS LOW. Track A's family signal was
  //      silently discarded.
  //
  // Tests below pin the corrected behaviour:
  // ────────────────────────────────────────────────────────────────────

  it('row-17 class: chapter_adjacent-only Track A + no merchant → escalate (does NOT throw)', async () => {
    // No merchant code at all. Picker found family signal in adjacent
    // chapters but no leaf-level fit. Without a merchant code to anchor
    // the chapter, we have no defensible final code — escalate.
    //
    // Pre-fix: classifyConflict returns AGREEMENT, handleAgreement
    // throws because topFitCandidate returns null.
    // Post-fix: classifyConflict returns ZERO_SIGNAL → escalate.
    const a = trackA({
      candidates: [
        ac('852852000000', 'chapter_adjacent', 0.08, 'GIR 3(a): monitors are output peripherals'),
        ac('852842000000', 'chapter_adjacent', 0.06, 'GIR 3(a): CRT monitors are output peripherals'),
        ac('900490900001', 'does_not_fit', 0.04, 'spectacles unrelated'),
      ],
      picker_confidence: 0.1,
    });
    const b = trackB({ resolved_code: null });
    const v = await runReconciliation(a, b, 'noctua cpu cooler');
    expect(v.decision).toBe('escalate');
    if (v.decision === 'escalate') {
      expect(v.classification_status).toBe('ZERO_SIGNAL');
    }
  });

  it('row-17 class (no candidates either): still ZERO_SIGNAL, still does not throw', async () => {
    // Defensive: even if Track A is completely empty, no merchant
    // code, no candidates — must escalate, not throw.
    const a = trackA({ candidates: [], threshold_failed: true });
    const b = trackB({ resolved_code: null });
    const v = await runReconciliation(a, b, 'something');
    expect(v.decision).toBe('escalate');
  });

  it('chapter_adjacent + ONE fits leaf + no merchant → AGREEMENT, returns the fits leaf', async () => {
    // Sanity guard: when Track A has both adjacent AND a real fits,
    // the fits wins via single_a path. AGREEMENT, no throw.
    const a = trackA({
      candidates: [
        ac('852852000000', 'chapter_adjacent', 0.08),
        ac('847330000000', 'fits', 0.20, 'computer parts'),
      ],
      picker_confidence: 0.7,
    });
    const b = trackB({ resolved_code: null });
    const v = (await runReconciliation(a, b, 'graphics card')) as VerdictResult;
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.final_code).toBe('847330000000');
    expect(v.source).toBe('description_classifier');
  });

  it('PR4.1 (row-8 GPU): chapter_adjacent + cross-chapter merchant code BEATS the confidence gate', async () => {
    // Production row 8: GPU graphics card, merchant 8471804000 (computer
    // parts, Ch 84). Track A correctly marked 852852 / 852842 etc as
    // chapter_adjacent (monitors are peripherals, ICs are components —
    // both in Ch 85, but adjacent to the Ch 84 computer-parts heading
    // the merchant points at). picker_confidence is ~0 because there
    // are no `fits` in Track A — only does_not_fit + chapter_adjacent.
    //
    // Pre-fix: PR1 confidence gate fires FIRST → demotes to AMBIGUOUS
    // LOW. The picker's explicit family signal is wasted.
    // Post-fix: chapter-family rule runs BEFORE the confidence gate.
    // Track A explicitly endorsed the family across an HS chapter
    // split — that's AGREEMENT, not AMBIGUOUS.
    const a = trackA({
      candidates: [
        ac('852852000000', 'chapter_adjacent', 0.08, 'GIR 3(a): monitors are output peripherals'),
        ac('852842000000', 'chapter_adjacent', 0.06, 'GIR 3(a): CRT monitors are output peripherals'),
        ac('382759000009', 'does_not_fit', 0.05, 'refrigerant gases'),
      ],
      // Confidence is below the 0.30 gate — pre-fix this would trigger
      // the demotion. The fix is that chapter-family wins anyway.
      picker_confidence: 0.05,
    });
    const b = trackB({
      resolved_code: '847180000000', // Ch 84 computer parts
      // valid_prefix length >= 6 is the gate's threshold; we use 8.
    });
    const v = (await runReconciliation(a, b, 'GPU graphics card')) as VerdictResult;
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.classification_status).toBe('AGREEMENT');
    expect(v.final_code).toBe('847180000000');
    expect(v.source).toBe('code_resolver');
    expect(v.rationale).toMatch(/chapter-family/i);
  });

  it('PR4.1 (row-23 Babybjorn): chapter_adjacent textile cradle + Ch 94 furniture merchant → AGREEMENT', async () => {
    // Babybjorn bouncer: Track A picked 6307 textile cradle as
    // chapter_adjacent, merchant 9401 seats (furniture). Different
    // chapters, same family. Track B's chapter-correct code wins.
    const a = trackA({
      candidates: [
        ac('630790950000', 'chapter_adjacent', 0.12, 'GIR 2(a) textile cover, primary class is seats'),
      ],
      picker_confidence: 0.20,
    });
    const b = trackB({ resolved_code: '940171000000' });
    const v = (await runReconciliation(a, b, 'babybjorn bouncer')) as VerdictResult;
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.final_code).toBe('940171000000');
    expect(v.source).toBe('code_resolver');
  });

  it('PR1 confidence gate still fires when there is NO chapter_adjacent signal (TORY 45 class)', async () => {
    // Sanity guard: the reordering must not break the row-135 fix.
    // Track A has a confident-looking `fits` on the wrong chapter
    // (no chapter_adjacent), merchant code carries 6+ digits, picker
    // confidence is below 0.30 — gate must fire → AMBIGUOUS → merchant
    // wins.
    const a = trackA({
      candidates: [ac('271019950005', 'fits', 0.30, 'matched petroleum')],
      picker_confidence: 0.05,
    });
    const b = trackB({ resolved_code: '640420000000' });
    const v = (await runReconciliation(a, b, 'TORY 45')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.final_code).toBe('640420000000');
    expect(v.source).toBe('code_resolver');
  });

  it('PR1 gate fires when chapter_adjacent exists but is in the SAME chapter as merchant', async () => {
    // Edge case: picker emitted chapter_adjacent but the candidate
    // chapter equals the merchant chapter. That's degenerate — the
    // chapter-family rule must NOT fire (not actually cross-chapter),
    // and the confidence gate must still fire on the low-confidence
    // picker output.
    const a = trackA({
      candidates: [
        ac('640420900000', 'chapter_adjacent', 0.10), // same Ch 64 as merchant
      ],
      picker_confidence: 0.05,
    });
    const b = trackB({ resolved_code: '640420000000' });
    const v = (await runReconciliation(a, b, 'footwear')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
  });

  it('chapter-family AGREEMENT requires that adjacent candidate be in a DIFFERENT chapter from resolver', async () => {
    // Same-chapter chapter_adjacent should not trigger chapter-family
    // AGREEMENT. Falls through to existing rules.
    const a = trackA({
      candidates: [ac('847330000000', 'chapter_adjacent', 0.20)],
      picker_confidence: 0.5,
    });
    const b = trackB({ resolved_code: '847180000000' }); // same Ch 84
    const v = await runReconciliation(a, b, 'computer part');
    // Should NOT be AGREEMENT-chapter-family; will fall through to
    // CONTRADICTION/AMBIGUOUS path. The key assertion is the
    // chapter-family rule did not capture it.
    if (v.decision === 'accept') {
      expect(v.rationale).not.toMatch(/chapter-family/i);
    }
  });

  it('chapter-family AGREEMENT does NOT fire when Track A has fits in resolver chapter', async () => {
    // Guard: if Track A has a `fits` IN the resolver's chapter, the
    // normal AGREEMENT rule (3) handles it. chapter-family must not
    // short-circuit clean fits.
    const a = trackA({
      candidates: [
        ac('847180000000', 'fits', 0.30, 'fits computer parts'),    // matches resolver chapter Ch 84
        ac('852852000000', 'chapter_adjacent', 0.10),
      ],
      picker_confidence: 0.7,
    });
    const b = trackB({ resolved_code: '847180000000' });
    const v = (await runReconciliation(a, b, 'computer part')) as VerdictResult;
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.final_code).toBe('847180000000');
    expect(v.rationale).not.toMatch(/chapter-family/i);
  });

  // ────────────────────────────────────────────────────────────────────
  // PR1.1+PR4.1 v2 — reviewer-blocker tests (2026-05-14)
  //
  // Peer reviewers flagged three precedence holes in the chapter-family
  // AGREEMENT rule (1a). Each test below names one and pins the
  // intended behaviour.
  // ────────────────────────────────────────────────────────────────────

  it("rule 1a must NOT fire when Track B's consistency_verdict is 'contradicts'", async () => {
    // architect-reviewer finding 4: when Track B's subtree retrieval has
    // already declared "my own description does not pull toward my own
    // chapter" (consistency_verdict='contradicts'), the merchant code is
    // discredited from Track B's own side. Track A saying "I see a related
    // family" must NOT rescue a self-contradicting merchant code into
    // AGREEMENT. Should fall through to the CONTRADICTION path (rule 2).
    //
    // Setup: Track A has a `fits` in a DIFFERENT chapter from the
    // resolver, plus a `chapter_adjacent` ALSO in a different chapter
    // from the resolver. Without the contradicts-guard, rule 1a fires
    // → AGREEMENT to merchant. With the guard + rule 2, CONTRADICTION
    // fires → Track A's fits wins.
    const a = trackA({
      candidates: [
        ac('630790950000', 'chapter_adjacent', 0.12, 'GIR 2(a) textile cradle'),
        ac('300490000000', 'fits', 0.30, 'medicament — Track A clearly disagrees'),
      ],
      picker_confidence: 0.6,
    });
    const b = trackB({
      resolved_code: '940171000000',
      consistency_verdict: 'contradicts', // Track B's own retrieval contradicts its merchant
    });
    const v = (await runReconciliation(a, b, 'baby bouncer')) as VerdictResult;
    expect(v.conflict_type).toBe('CONTRADICTION');
    expect(v.rationale).not.toMatch(/chapter-family/i);
  });

  it("rule 1a must NOT fire when Track A has partial_family in resolver's chapter", async () => {
    // architect-reviewer finding 7: a partial_family leaf in the resolver
    // chapter is leaf-level signal that should resolve via the normal
    // AMBIGUOUS rule. chapter-family must not bury a leaf endorsement
    // under a family-level one.
    //
    // Setup choice: partial_family code is in resolver chapter (Ch 94)
    // but a DIFFERENT heading (9403 furniture vs 9401 seats) so we
    // route to AMBIGUOUS (rule 5/6), not DRIFT (which needs the LLM
    // mocked). The point being tested is that rule 1a doesn't fire,
    // which is independent of the DRIFT-vs-AMBIGUOUS terminal.
    const a = trackA({
      candidates: [
        ac('940360100000', 'partial_family', 0.20, 'wooden furniture — material silent'),
        ac('630790950000', 'chapter_adjacent', 0.10),
      ],
      picker_confidence: 0.5,
    });
    const b = trackB({ resolved_code: '940171000000' });
    const v = (await runReconciliation(a, b, 'baby seat')) as VerdictResult;
    // Should NOT cite chapter-family in the rationale (would prove rule
    // 1a fired). Asserting the rationale is the discriminator —
    // conflict_type can be either AMBIGUOUS (no convergence) or
    // CONTRADICTION-via-confidence-demotion, both of which are fine;
    // what matters is that rule 1a was skipped.
    expect(v.rationale).not.toMatch(/chapter-family/i);
  });

  it("rule 1a must NOT fire when Track A has fits in a DIFFERENT chapter from both adjacent and resolver", async () => {
    // code-reviewer issue 4: Track A has a fits in Ch 90, chapter_adjacent
    // pointing at a different chapter, resolver in yet another chapter.
    // Track A's leaf-level fits is the strongest signal — it should not
    // be silently buried by a family-level adjacent endorsement of a
    // different chapter.
    const a = trackA({
      candidates: [
        ac('900490100001', 'fits', 0.30, 'optical instruments'),     // Ch 90
        ac('852852000000', 'chapter_adjacent', 0.10),                  // Ch 85, adjacent to Ch 84 merchant
      ],
      picker_confidence: 0.6,
    });
    const b = trackB({ resolved_code: '847180000000' });               // Ch 84
    const v = (await runReconciliation(a, b, 'optical sensor')) as VerdictResult;
    // Track A's leaf fits in Ch 90 must win the precedence; rule 1a
    // would have routed to AGREEMENT-merchant-Ch-84. Must reach the
    // CONTRADICTION path (rule 2) where Track A's leaf wins.
    expect(v.decision).toBe('accept');
    expect(v.conflict_type).toBe('CONTRADICTION');
    expect(v.rationale).not.toMatch(/chapter-family/i);
  });
});
