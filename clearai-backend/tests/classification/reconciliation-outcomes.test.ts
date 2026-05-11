/**
 * Reconciliation outcome map.
 *
 * Each internal conflict type maps to a specific (decision, confidence_band,
 * source) tuple. These tests pin those tuples so a future regression is loud.
 *
 *   AGREEMENT          → accept, HIGH,    classification_status=AGREEMENT
 *   DRIFT              → accept, MEDIUM,  classification_status=DRIFT
 *   AMBIGUOUS_MATERIAL → accept, LOW,     classification_status=DRIFT
 *   SPARSE_DESCRIPTION → accept, LOW,     classification_status=DRIFT
 *   CONTRADICTION      → accept, MEDIUM,  classification_status=DRIFT
 *                        (Track A rank-1 wins; merchant code overridden)
 *   ZERO_SIGNAL        → escalate
 *
 * audit_flag was removed in V1 (no post-clearance audit). The DRIFT path
 * involves the LLM, which we mock. Other paths are deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classificationStatusFromConflictType,
  type TrackAResult,
  type TrackBResult,
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

import { runReconciliation } from '../../src/modules/pipeline/stage-2-verdict/reconciliation.js';

function ac(code: string, fit: CandidateFitVerdict, rrf = 0.05, rationale = 'test'): AnnotatedCandidate {
  return { code, description_en: code, description_ar: null, rrf_score: rrf, fit, rationale };
}

function trackA(opts: {
  candidates?: AnnotatedCandidate[];
  no_fit?: boolean;
  threshold_failed?: boolean;
}): TrackAResult {
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
  subtree_top_code?: string;
}): TrackBResult {
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
  // AGREEMENT → HIGH
  // ──────────────────────────────────────────────────────────
  it('AGREEMENT (resolver in fits): accept, HIGH, source=code_resolver', async () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'wireless headphones')) as VerdictResult;
    expect(v.decision).toBe('accept');
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.confidence_band).toBe('high');
    expect(v.source).toBe('code_resolver');
    expect(v.final_code).toBe('851830900003');
  });

  it('AGREEMENT (single_a fits): accept, HIGH, source=description_classifier', async () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({}); // no resolved_code
    const v = (await runReconciliation(a, b, 'wireless headphones')) as VerdictResult;
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.confidence_band).toBe('high');
    expect(v.source).toBe('description_classifier');
  });

  // ──────────────────────────────────────────────────────────
  // CONTRADICTION → MEDIUM, Track A rank-1 wins
  // ──────────────────────────────────────────────────────────
  it('CONTRADICTION (consistency_verdict=contradicts): accept, MEDIUM, Track A rank-1 wins', async () => {
    const a = trackA({ candidates: [ac('460200000000', 'fits')] });
    const b = trackB({ resolved_code: '630790300000', consistency_verdict: 'contradicts' });
    const v = (await runReconciliation(a, b, 'storage basket')) as VerdictResult;
    expect(v.conflict_type).toBe('CONTRADICTION');
    expect(v.confidence_band).toBe('medium');
    expect(v.final_code).toBe('460200000000');
    expect(v.source).toBe('description_classifier');
  });

  it('PR 6.1: when consistency_verdict=contradicts BUT Track A has no fits/partial, demotes to SPARSE_DESCRIPTION (no longer CONTRADICTION)', async () => {
    // Pre-PR-6.1 this case promoted the unanchored top-1 (subtree_candidates[0])
    // to the answer, even though Track A's retrieval was hallucinating. The
    // hoodie case (2026-05-10) showed that's worse than passing the override
    // through. Now: Track A signal is unreliable → SPARSE_DESCRIPTION,
    // resolver carries the row at LOW confidence with audit.
    const a = trackA({ candidates: [ac('630790300000', 'does_not_fit')] });
    const b = trackB({
      resolved_code: '630790300000',
      consistency_verdict: 'contradicts',
      subtree_top_code: '460200000000',
    });
    const v = (await runReconciliation(a, b, 'storage basket')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.final_code).toBe('630790300000'); // resolver code, not the hallucinated unanchored top
    expect(v.confidence_band).toBe('low');
  });

  // ──────────────────────────────────────────────────────────
  // AMBIGUOUS_MATERIAL → LOW, source=code_resolver
  // ──────────────────────────────────────────────────────────
  it('AMBIGUOUS_MATERIAL: accept, LOW, source=code_resolver', async () => {
    // Track A produces a partial in a different heading; Track B has
    // a resolved code. No fits, no chapter mismatch on a fits, no DRIFT
    // (headings differ), not SPARSE.
    const a = trackA({ candidates: [ac('851712000000', 'partial')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'some audio device')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.confidence_band).toBe('low');
    expect(v.source).toBe('code_resolver');
    expect(v.final_code).toBe('851830900003');
  });

  // ──────────────────────────────────────────────────────────
  // SPARSE_DESCRIPTION → LOW
  // ──────────────────────────────────────────────────────────
  it('SPARSE_DESCRIPTION (no_fit): accept, LOW', async () => {
    const a = trackA({ no_fit: true });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'thin description')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.confidence_band).toBe('low');
    expect(v.source).toBe('code_resolver');
  });

  it('SPARSE_DESCRIPTION (threshold_failed): accept, LOW', async () => {
    const a = trackA({ threshold_failed: true });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'thin description')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS');
    expect(v.confidence_band).toBe('low');
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
  // DRIFT → LLM call. Verify the outcome map for both LLM success
  // and LLM failure paths.
  // ──────────────────────────────────────────────────────────
  it('DRIFT (LLM picks a leaf): accept, MEDIUM', async () => {
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
    expect(v.confidence_band).toBe('medium');
    expect(v.final_code).toBe('620463000004');
  });

  it('DRIFT (LLM unavailable, resolver code present): falls through to code_resolver at LOW with audit', async () => {
    structuredLlmCallMock.mockResolvedValueOnce({
      kind: 'llm_failed',
      error: 'HTTP 503',
      trace: {},
    });
    const a = trackA({ candidates: [ac('620463000004', 'partial')] });
    const b = trackB({ resolved_code: '620463000000' });
    const v = (await runReconciliation(a, b, 'bootcut legging')) as VerdictResult;
    // LLM-failure-during-DRIFT specifically falls back to resolver at LOW + audit.
    expect(v.conflict_type).toBe('DRIFT');
    expect(v.confidence_band).toBe('low');
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
