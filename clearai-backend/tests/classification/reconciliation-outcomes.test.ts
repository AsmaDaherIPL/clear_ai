/**
 * PR 6: reconciliation outcome map.
 *
 * Each conflict type maps to a specific (decision, confidence_band, source,
 * audit_flag) tuple per the canonical outcome map. These tests pin those
 * tuples explicitly so a future regression is loud.
 *
 *   AGREEMENT          → accept, HIGH,    audit_flag: false
 *   DRIFT              → accept, MEDIUM,  audit_flag: true (mandatory)
 *   AMBIGUOUS_MATERIAL → accept, LOW,     audit_flag: true (sampled in PR 7)
 *   SPARSE_DESCRIPTION → accept, LOW,     audit_flag: true (sampled in PR 7)
 *   CONTRADICTION      → accept, MEDIUM,  audit_flag: true (mandatory).
 *                        Track A rank-1 wins; merchant code overridden.
 *   ZERO_SIGNAL        → escalate.
 *
 * The DRIFT path involves the LLM, which we mock. Other paths are
 * deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  TrackAResult,
  TrackBResult,
  AnnotatedCandidate,
  CandidateFitVerdict,
  ConsistencyVerdict,
  VerdictResult,
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
  // AGREEMENT → HIGH, audit_flag: false
  // ──────────────────────────────────────────────────────────
  it('AGREEMENT (resolver in fits): accept, HIGH, audit_flag=false, source=code_resolver', async () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'wireless headphones')) as VerdictResult;
    expect(v.decision).toBe('accept');
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.confidence_band).toBe('high');
    expect(v.audit_flag).toBe(false);
    expect(v.source).toBe('code_resolver');
    expect(v.final_code).toBe('851830900003');
  });

  it('AGREEMENT (single_a fits): accept, HIGH, audit_flag=false, source=description_classifier', async () => {
    const a = trackA({ candidates: [ac('851830900003', 'fits')] });
    const b = trackB({}); // no resolved_code
    const v = (await runReconciliation(a, b, 'wireless headphones')) as VerdictResult;
    expect(v.conflict_type).toBe('AGREEMENT');
    expect(v.confidence_band).toBe('high');
    expect(v.audit_flag).toBe(false);
    expect(v.source).toBe('description_classifier');
  });

  // ──────────────────────────────────────────────────────────
  // CONTRADICTION → MEDIUM, audit_flag: true, Track A rank-1 wins
  // ──────────────────────────────────────────────────────────
  it('CONTRADICTION (consistency_verdict=contradicts): accept, MEDIUM, audit_flag=true, Track A rank-1 wins', async () => {
    const a = trackA({ candidates: [ac('460200000000', 'fits')] });
    const b = trackB({ resolved_code: '630790300000', consistency_verdict: 'contradicts' });
    const v = (await runReconciliation(a, b, 'storage basket')) as VerdictResult;
    expect(v.conflict_type).toBe('CONTRADICTION');
    expect(v.confidence_band).toBe('medium');
    expect(v.audit_flag).toBe(true);
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
    expect(v.conflict_type).toBe('SPARSE_DESCRIPTION');
    expect(v.final_code).toBe('630790300000'); // resolver code, not the hallucinated unanchored top
    expect(v.confidence_band).toBe('low');
    expect(v.audit_flag).toBe(true);
  });

  // ──────────────────────────────────────────────────────────
  // AMBIGUOUS_MATERIAL → LOW, audit_flag: true, source=code_resolver
  // ──────────────────────────────────────────────────────────
  it('AMBIGUOUS_MATERIAL: accept, LOW, audit_flag=true, source=code_resolver', async () => {
    // Track A produces a partial in a different heading; Track B has
    // a resolved code. No fits, no chapter mismatch on a fits, no DRIFT
    // (headings differ), not SPARSE.
    const a = trackA({ candidates: [ac('851712000000', 'partial')] });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'some audio device')) as VerdictResult;
    expect(v.conflict_type).toBe('AMBIGUOUS_MATERIAL');
    expect(v.confidence_band).toBe('low');
    expect(v.audit_flag).toBe(true);
    expect(v.source).toBe('code_resolver');
    expect(v.final_code).toBe('851830900003');
  });

  // ──────────────────────────────────────────────────────────
  // SPARSE_DESCRIPTION → LOW, audit_flag: true
  // ──────────────────────────────────────────────────────────
  it('SPARSE_DESCRIPTION (no_fit): accept, LOW, audit_flag=true', async () => {
    const a = trackA({ no_fit: true });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'thin description')) as VerdictResult;
    expect(v.conflict_type).toBe('SPARSE_DESCRIPTION');
    expect(v.confidence_band).toBe('low');
    expect(v.audit_flag).toBe(true);
    expect(v.source).toBe('code_resolver');
  });

  it('SPARSE_DESCRIPTION (threshold_failed): accept, LOW, audit_flag=true', async () => {
    const a = trackA({ threshold_failed: true });
    const b = trackB({ resolved_code: '851830900003' });
    const v = (await runReconciliation(a, b, 'thin description')) as VerdictResult;
    expect(v.conflict_type).toBe('SPARSE_DESCRIPTION');
    expect(v.confidence_band).toBe('low');
    expect(v.audit_flag).toBe(true);
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
  it('DRIFT (LLM picks a leaf): accept, MEDIUM, audit_flag=true (mandatory)', async () => {
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
    expect(v.audit_flag).toBe(true);
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
    expect(v.audit_flag).toBe(true);
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
