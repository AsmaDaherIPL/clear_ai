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
  return {
    annotated_candidates: opts.candidates ?? [],
    threshold_failed: opts.threshold_failed ?? false,
    no_fit: opts.no_fit ?? !(opts.candidates ?? []).some((c) => c.fit === 'fits' || c.fit === 'partial'),
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
});
