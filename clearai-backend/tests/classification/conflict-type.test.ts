/**
 * PR 6: classifyConflict deterministic precedence tests.
 *
 * Pins the order of conflict-type rules:
 *   1. ZERO_SIGNAL
 *   2. CONTRADICTION  (consistency_verdict='contradicts'
 *                      OR cross-track chapter mismatch
 *                      OR cross-track heading mismatch when A top is fits and resolver is not)
 *   3. AGREEMENT       (resolver in fits set, OR single_a top is fits)
 *   4. DRIFT           (heading match, leaf disagreement)
 *   5. SPARSE_DESCRIPTION (Track A no_fit/threshold_failed + Track B has code)
 *   6. AMBIGUOUS_MATERIAL (default fall-through)
 */
import { describe, it, expect } from 'vitest';
import { classifyConflict } from '../../src/modules/pipeline/classify/reconciliation/conflict-type.js';
import type {
  DescriptionClassifierResult,
  CodeResolverResult,
  AnnotatedCandidate,
  CandidateFitVerdict,
  ConsistencyVerdict,
} from '../../src/modules/pipeline/shared/pipeline.types.js';

function ac(code: string, fit: CandidateFitVerdict, rrf = 0.05): AnnotatedCandidate {
  return { code, description_en: code, description_ar: null, rrf_score: rrf, fit, rationale: '' };
}

function trackA(opts: {
  candidates?: AnnotatedCandidate[];
  no_fit?: boolean;
  threshold_failed?: boolean;
}): DescriptionClassifierResult {
  return {
    annotated_candidates: opts.candidates ?? [],
    threshold_failed: opts.threshold_failed ?? false,
    no_fit: opts.no_fit ?? !(opts.candidates ?? []).some((c) => c.fit === 'fits' || c.fit === 'partial'),
    interpretation_stage: 'cleaned',
    effective_description: 'test',
    research: null,
    web_research: null,
  };
}

function trackB(opts: {
  resolved_code?: string | null;
  consistency_verdict?: ConsistencyVerdict;
  override_applied?: boolean;
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
    subtree_candidates: [],
  };
}

describe('classifyConflict — precedence tests', () => {
  // ──────────────────────────────────────────────────────────
  // 1. ZERO_SIGNAL
  // ──────────────────────────────────────────────────────────
  it('ZERO_SIGNAL: both tracks empty (no fits/partial in A, no resolved_code in B)', () => {
    const a = trackA({ candidates: [ac('010101000000', 'does_not_fit')] });
    const b = trackB({});
    expect(classifyConflict(a, b)).toBe('ZERO_SIGNAL');
  });

  it('ZERO_SIGNAL: track A empty AND track B has no resolved code', () => {
    expect(classifyConflict(trackA({}), trackB({}))).toBe('ZERO_SIGNAL');
  });

  // ──────────────────────────────────────────────────────────
  // 2. CONTRADICTION
  // ──────────────────────────────────────────────────────────
  it('CONTRADICTION: trackB.consistency_verdict = contradicts (PR 5 hard prefix violation)', () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({ resolved_code: '630790300000', consistency_verdict: 'contradicts' });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  it('CONTRADICTION: cross-track chapter mismatch even when consistency_verdict is consistent', () => {
    const a = trackA({ candidates: [ac('460200000000', 'fits')] }); // chapter 46
    const b = trackB({ resolved_code: '630790300000', consistency_verdict: 'consistent' }); // chapter 63
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  it('CONTRADICTION beats AGREEMENT when consistency_verdict=contradicts even if resolver code is in fits set', () => {
    // The subtree retrieval said the description disagrees at chapter level —
    // even if Track A happens to also have the resolver code as fits, the
    // subtree retrieval flagged a chapter mismatch. Trust PR 5.
    const a = trackA({ candidates: [ac('630790300000', 'fits')] });
    const b = trackB({ resolved_code: '630790300000', consistency_verdict: 'contradicts' });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  // PR 6.1 — guard against Track A hallucinations on CONTRADICTION
  it('PR 6.1 guard: consistency_verdict=contradicts but Track A has no fits/partial → SPARSE_DESCRIPTION (not CONTRADICTION)', () => {
    // The hoodie case from 2026-05-10 batch 019e118a: Arabic input "هودي محبوك"
    // produced 12 unrelated candidates (wood, honey, vanilla) all does_not_fit.
    // PR 5's subtree retrieval also flagged contradicts. Pre-PR-6.1 this was
    // promoted to CONTRADICTION and Track A's hallucinated rank-1 (wood
    // jewellery) became the answer — worse than passing the override through.
    const a = trackA({
      candidates: [
        ac('711790300000', 'does_not_fit'),
        ac('711700000000', 'does_not_fit'),
        ac('440420100001', 'does_not_fit'),
      ],
    });
    const b = trackB({ resolved_code: '620442000000', consistency_verdict: 'contradicts' });
    // With the guard: Track A has no fits/partial → don't trust Track A's rank-1.
    // Track B has resolved_code → SPARSE_DESCRIPTION (resolver carries the row at low confidence).
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  it('PR 6.1 guard: consistency_verdict=contradicts AND Track A empty AND Track B empty → ZERO_SIGNAL', () => {
    const a = trackA({});
    const b = trackB({ consistency_verdict: 'contradicts' }); // no resolved_code
    expect(classifyConflict(a, b)).toBe('ZERO_SIGNAL');
  });

  it('PR 6.1 guard: CONTRADICTION still fires when Track A has a partial (not just fits)', () => {
    // The guard only blocks CONTRADICTION when Track A has NEITHER fits NOR
    // partial. A partial-only Track A combined with consistency_verdict=
    // contradicts is still a real chapter mismatch worth surfacing.
    const a = trackA({ candidates: [ac('460200000000', 'partial')] });
    const b = trackB({ resolved_code: '630790300000', consistency_verdict: 'contradicts' });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  // ──────────────────────────────────────────────────────────
  // 2c. CONTRADICTION (heading-level cross-track, asymmetric-confidence)
  //
  // Track A's rank-1 fit is `fits` in a DIFFERENT HEADING than the resolver
  // code, AND the resolver code is NOT in Track A's fits set. Two product
  // families in the same chapter (e.g. 8517 telephone equipment vs 8518
  // audio equipment) should reconcile to CONTRADICTION, not collapse to
  // AMBIGUOUS_MATERIAL.
  //
  // Pinned scenario: run 019e11f2-... item 1 (wireless headphones).
  //   Track A rank-1 fit  = 851762900009 (heading 8517, fits)
  //   Resolver code        = 851830900003 (heading 8518, partial in A)
  //   Pre-fix verdict      = AMBIGUOUS_MATERIAL (low confidence)
  //   Post-fix verdict     = CONTRADICTION (medium confidence, Track A wins)
  // ──────────────────────────────────────────────────────────
  it('CONTRADICTION (2c): heading mismatch, A rank-1 fits, resolver NOT in fits set', () => {
    const a = trackA({
      candidates: [
        ac('851830900004', 'does_not_fit', 0.019), // wired headphones, rank-1 by RRF but does_not_fit
        ac('851762900009', 'fits', 0.0186),         // wireless headphones — top fits in A
        ac('851830900003', 'partial', 0.0176),      // resolver target — partial in A
      ],
    });
    const b = trackB({ resolved_code: '851830900003', consistency_verdict: 'ambiguous' });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  it('NOT CONTRADICTION (2c): heading mismatch BUT resolver is also in A fits set → AGREEMENT', () => {
    // If Track A endorses both headings as `fits`, this isn't a contradiction —
    // resolver code being in the fits set means AGREEMENT (rule 3) wins.
    const a = trackA({
      candidates: [
        ac('851762900009', 'fits'),
        ac('851830900003', 'fits'), // resolver also fits
      ],
    });
    const b = trackB({ resolved_code: '851830900003' });
    expect(classifyConflict(a, b)).toBe('AGREEMENT');
  });

  it('NOT CONTRADICTION (2c): heading mismatch but A top is partial (not fits) → falls through', () => {
    // Asymmetric-confidence guard requires Track A's top to be `fits`,
    // not just `partial`. With `partial`, signal isn't strong enough to
    // override merchant code; falls through to AMBIGUOUS_MATERIAL.
    const a = trackA({
      candidates: [ac('851762900009', 'partial'), ac('851830900003', 'does_not_fit')],
    });
    const b = trackB({ resolved_code: '851830900003' });
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  it('CONTRADICTION (2c): same chapter, different heading, resolver does_not_fit in A', () => {
    // Chapter 62 vs 62 — 2b chapter-rule doesn't fire (same chapter).
    // Heading 6204 vs 6203 — 2c heading rule should fire because A top is
    // fits in 6204 and resolver in 6203 is does_not_fit in A.
    const a = trackA({
      candidates: [
        ac('620442000000', 'fits'),
        ac('620342000004', 'does_not_fit'), // resolver in A, marked does_not_fit
      ],
    });
    const b = trackB({ resolved_code: '620342000004' });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  // ──────────────────────────────────────────────────────────
  // 3. AGREEMENT
  // ──────────────────────────────────────────────────────────
  it('AGREEMENT: resolver code is in trackA.annotated_candidates with fit=fits', () => {
    const a = trackA({
      candidates: [ac('851830900003', 'fits'), ac('851830900001', 'partial')],
    });
    const b = trackB({ resolved_code: '851830900003', consistency_verdict: 'consistent' });
    expect(classifyConflict(a, b)).toBe('AGREEMENT');
  });

  it('AGREEMENT: single_a path with a fits top candidate (no resolver)', () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({}); // no resolved_code
    expect(classifyConflict(a, b)).toBe('AGREEMENT');
  });

  it('AGREEMENT: single_a path with ONLY partial candidates (no resolver, no fits)', () => {
    // Regression: previously fell through to AMBIGUOUS, which threw because
    // the handler requires trackB.resolved_code. Now AGREEMENT — Track A's
    // top partial is the only signal we have; better to accept it than
    // crash. Pinned scenario: "Jackets" input, no merchant code, picker
    // labeled every candidate `partial` because every leaf constrains
    // gender/material which the description does not state.
    const a = trackA({
      candidates: [
        ac('610330000000', 'partial', 0.039),
        ac('620100000000', 'partial', 0.038),
      ],
    });
    const b = trackB({}); // no resolved_code
    expect(classifyConflict(a, b)).toBe('AGREEMENT');
  });

  it('NOT AGREEMENT: resolver code is in fits set BUT chapter mismatch (caught by CONTRADICTION 2b)', () => {
    // Same chapter 85 vs 63 — Track A top fit is 85, resolver is 63.
    // Resolver IS in Track A but as does_not_fit, so AGREEMENT rule 3 doesn't fire.
    const a = trackA({
      candidates: [ac('851830900003', 'fits'), ac('630790300000', 'does_not_fit')],
    });
    const b = trackB({ resolved_code: '630790300000' });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  // ──────────────────────────────────────────────────────────
  // 4. DRIFT
  // ──────────────────────────────────────────────────────────
  it('DRIFT: same heading (HS4), different leaves', () => {
    // Both are 6204.42.* — same HS4 heading 6204, different leaves.
    const a = trackA({ candidates: [ac('620442000004', 'partial')] });
    const b = trackB({ resolved_code: '620442000000' });
    expect(classifyConflict(a, b)).toBe('DRIFT');
  });

  it('DRIFT: heading matches, top is partial (still drift since leaves differ)', () => {
    const a = trackA({ candidates: [ac('620442000003', 'partial')] });
    const b = trackB({ resolved_code: '620442000000' });
    expect(classifyConflict(a, b)).toBe('DRIFT');
  });

  it('NOT DRIFT: same exact code → AGREEMENT', () => {
    const a = trackA({ candidates: [ac('620442000000', 'fits')] });
    const b = trackB({ resolved_code: '620442000000' });
    expect(classifyConflict(a, b)).toBe('AGREEMENT');
  });

  // ──────────────────────────────────────────────────────────
  // 5. SPARSE_DESCRIPTION
  // ──────────────────────────────────────────────────────────
  it('SPARSE_DESCRIPTION: trackA.no_fit=true and trackB has resolved_code', () => {
    const a = trackA({ no_fit: true });
    const b = trackB({ resolved_code: '851830900003' });
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  it('SPARSE_DESCRIPTION: trackA.threshold_failed=true and trackB has resolved_code', () => {
    const a = trackA({ threshold_failed: true });
    const b = trackB({ resolved_code: '851830900003' });
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  it('NOT SPARSE: track A has no_fit but track B has no resolved code → ZERO_SIGNAL', () => {
    const a = trackA({ no_fit: true });
    const b = trackB({});
    expect(classifyConflict(a, b)).toBe('ZERO_SIGNAL');
  });

  // ──────────────────────────────────────────────────────────
  // 6. AMBIGUOUS_MATERIAL (default fall-through)
  // ──────────────────────────────────────────────────────────
  it('AMBIGUOUS_MATERIAL: trackA has partial candidates only, trackB has resolver, headings disagree, no chapter mismatch with top fits (no top fits)', () => {
    // Track A top is partial (not fits); resolver is in chapter 85 too but at a different heading.
    // No CONTRADICTION (no chapter mismatch on top FITS — top is partial), no AGREEMENT (resolver
    // not in fits set), no DRIFT (headings differ — 8517 vs 8518), not SPARSE (Track A has signal).
    const a = trackA({ candidates: [ac('851712000000', 'partial')] });
    const b = trackB({ resolved_code: '851830900003' });
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  it('AMBIGUOUS_MATERIAL: trackA top is partial in same chapter; trackB resolver also matches that chapter at a different heading', () => {
    const a = trackA({ candidates: [ac('620462000004', 'partial')] }); // 6204.62 → heading 6204
    const b = trackB({ resolved_code: '620510000000' }); // 6205.10 → heading 6205
    // Same chapter 62, different heading — no CONTRADICTION (top is partial not fits, so 2b
    // doesn't fire), no AGREEMENT, no DRIFT (headings differ), not SPARSE.
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  it('AMBIGUOUS_MATERIAL: when consistency_verdict=ambiguous and resolver is in partial set', () => {
    const a = trackA({ candidates: [ac('851712000000', 'partial')] });
    const b = trackB({ resolved_code: '851830900003', consistency_verdict: 'ambiguous' });
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  // ──────────────────────────────────────────────────────────
  // Override metadata is independent of classification
  // ──────────────────────────────────────────────────────────
  it('override_applied does not change conflict type by itself — same code in both tracks is still AGREEMENT', () => {
    const a = trackA({ candidates: [ac('620442000000', 'fits')] });
    const b = trackB({
      resolved_code: '620442000000',
      override_applied: true,
    });
    expect(classifyConflict(a, b)).toBe('AGREEMENT');
  });

  // ──────────────────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────────────────
  it('handles empty candidates array correctly when trackB has resolved_code', () => {
    const a = trackA({});
    const b = trackB({ resolved_code: '851830900003' });
    // single_b path: no Track A signal, B has code — SPARSE since no_fit=true.
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  it('handles 6-digit (heading-only) resolved_code without crashing', () => {
    const a = trackA({ candidates: [ac('851830', 'fits')] });
    const b = trackB({ resolved_code: '851830' });
    expect(classifyConflict(a, b)).toBe('AGREEMENT');
  });
});
