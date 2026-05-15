/**
 * PR 12 — wire-format adapter + dispatch-v1 v2 branch tests.
 *
 * Pure-function tests. No LLM, no DB, no orchestrator. Build a
 * PipelineResultV2 by hand, send it through adaptV2ToPipelineResult,
 * then through assembleDispatchV1, then assert the shape of the
 * resulting DispatchV1Response.
 */
import { describe, expect, it } from 'vitest';
import { adaptV2ToPipelineResult } from '../../src/modules/pipeline/v2/adapter.js';
import { assembleDispatchV1 } from '../../src/modules/pipeline/trace/dispatch-v1.js';
import type {
  IdentifyResult,
  MerchantResolution,
  MerchantResolutionTrace,
  PickAccepted,
  PickEscalate,
  PipelineResultV2,
  PipelineTraceV2,
  ScopeSelection,
  VerifierResult,
} from '../../src/modules/pipeline/v2/types.js';
import type { SanityResult } from '../../src/modules/pipeline/shared/pipeline.types.js';

const fastTrace: IdentifyResult extends { trace: infer T } ? T : never =
  {
    pass: 'fast',
    llm_called: true,
    latency_ms: 1500,
    model: 'mock-sonnet',
    status: 'ok',
    web_search_used: false,
    evidence_mismatch: false,
  };

const cleanIdentify: IdentifyResult = {
  kind: 'clean_product',
  canonical: 'cotton t-shirt',
  family_chapter: '61',
  identity_tokens: [],
  confidence: 0.92,
  evidence: 'world_knowledge',
  trace: fastTrace,
};

const merchantActive: MerchantResolution = {
  state: 'active',
  source_code: '610910000000',
  resolved_code: '610910000000',
};
const merchantResolutionTrace: MerchantResolutionTrace = {
  llm_called: false,
  latency_ms: 12,
  override_attempted: false,
  override_matched: false,
};

const scopePrefixOnly: ScopeSelection = {
  primary: { kind: 'merchant_prefix', prefix: '61091000', source: 'merchant_active' },
  secondaries: [],
  audit_flags: [],
};

const pickAccepted: PickAccepted = {
  kind: 'accepted',
  final_code: '610910000000',
  fit: 'fits',
  confidence: 0.88,
  gir_applied: 'GIR 1',
  verdict_population: { fits: 1, partial: 0, does_not_fit: 0 },
  picked_from_arm: 'merchant_prefix',
  merchant_chapter_disagreement: false,
  candidate_count_by_arm: { merchant_prefix: 5 },
  trace: {
    llm_called: true,
    latency_ms: 4200,
    model: 'mock-sonnet',
    status: 'ok',
    candidate_count: 5,
    audit_flag: false,
  },
};

const verifyPass: VerifierResult = { result: 'PASS', rules_triggered: [] };

const sanityPass: SanityResult = {
  verdict: 'PASS',
  rationale: 'value looks right',
  latency_ms: 800,
  degraded: false,
};

function buildResultV2(overrides: Partial<PipelineResultV2> = {}): PipelineResultV2 {
  const trace: PipelineTraceV2 = {
    identify: cleanIdentify,
    merchant_resolution: { resolution: merchantActive, trace: merchantResolutionTrace },
    scope: scopePrefixOnly,
    retrieval: {
      primary_candidate_count: 5,
      secondary_candidate_counts: {},
      candidates_before_rerank: 5,
      candidates_after_rerank: 5,
    },
    pick: pickAccepted,
    verify: verifyPass,
    sanity: sanityPass,
    stages: [],
  };
  return {
    final_code: '610910000000',
    goods_description_ar: 'تي شيرت قطني',
    sanity_verdict: 'PASS',
    classification_status: 'AGREEMENT',
    hitl: null,
    trace,
    infra_degraded: false,
    ...overrides,
  };
}

describe('adaptV2ToPipelineResult', () => {
  it('preserves final_code / goods_description_ar / sanity_verdict / hitl / infra_degraded', () => {
    const v2 = buildResultV2();
    const adapted = adaptV2ToPipelineResult(v2);
    expect(adapted.final_code).toBe('610910000000');
    expect(adapted.goods_description_ar).toBe('تي شيرت قطني');
    expect(adapted.sanity_verdict).toBe('PASS');
    expect(adapted.hitl).toBeNull();
    expect(adapted.infra_degraded).toBe(false);
  });

  it("sets pipeline_architecture='v2' on the trace", () => {
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    expect(adapted.trace.pipeline_architecture).toBe('v2');
  });

  it('nulls out legacy + anchored trace fields', () => {
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    expect(adapted.trace.track_a).toBeNull();
    expect(adapted.trace.track_b).toBeNull();
    expect(adapted.trace.verdict).toBeNull();
    expect(adapted.trace.anchored_identify).toBeNull();
    expect(adapted.trace.anchored_constrain).toBeNull();
    expect(adapted.trace.anchored_pick).toBeNull();
  });

  it('carries the v2 trace under pipeline_v2', () => {
    const v2 = buildResultV2();
    const adapted = adaptV2ToPipelineResult(v2);
    expect(adapted.trace.pipeline_v2).toBe(v2.trace);
  });

  it("defaults sanity_verdict to 'PASS' when v2 returns null (escalate path)", () => {
    const v2 = buildResultV2({ sanity_verdict: null });
    const adapted = adaptV2ToPipelineResult(v2);
    expect(adapted.sanity_verdict).toBe('PASS');
  });
});

describe('assembleDispatchV1 — v2 branch', () => {
  it("emits pipeline_architecture='v2' on the summary", () => {
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.summary.pipeline_architecture).toBe('v2');
  });

  it('populates v2-only summary fields (identify_pass, picked_from_arm, verifier_result)', () => {
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.summary.identify_pass).toBe('fast');
    expect(v1.trace.summary.picked_from_arm).toBe('merchant_prefix');
    expect(v1.trace.summary.verifier_result).toBe('PASS');
    expect(v1.trace.summary.verifier_rules_triggered).toEqual([]);
    expect(v1.trace.summary.merchant_chapter_disagreement).toBe(false);
    expect(v1.trace.summary.candidate_count_by_arm).toEqual({ merchant_prefix: 5 });
    expect(v1.trace.summary.secondary_arm_count).toBe(0);
  });

  it('nulls out legacy + anchored summary fields under v2', () => {
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.summary.description_classifier_top_fit).toBeNull();
    expect(v1.trace.summary.code_resolver_code).toBeNull();
    expect(v1.trace.summary.reconciliation).toBeNull();
  });

  it('emits the three top-level wire stages: normalize, classify, sanity', () => {
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.stages.map((s) => s.stage)).toEqual(['normalize', 'classify', 'sanity']);
  });

  it('emits v2 actions inside classify in pipeline order', () => {
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    const classify = v1.trace.stages.find((s) => s.stage === 'classify');
    expect(classify).toBeDefined();
    const actions = classify!.actions.map((a) => a.action);
    expect(actions).toEqual([
      'identify',
      'merchant_resolution',
      'scope_selection',
      'multi_arm_retrieval',
      'rerank',
      'pick',
      'verify',
      'submission_description',
    ]);
  });

  it('identify action surfaces pass discriminator inside output', () => {
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    const classify = v1.trace.stages.find((s) => s.stage === 'classify')!;
    const identifyAction = classify.actions.find((a) => a.action === 'identify')!;
    expect(identifyAction.output?.pass).toBe('fast');
    expect(identifyAction.output?.kind).toBe('clean_product');
    expect(identifyAction.merchant_code_visible_to_model).toBe(false);
  });

  it('multi_arm_retrieval emits one step per active arm', () => {
    const v2 = buildResultV2();
    // Add a family_chapter secondary.
    v2.trace.scope = {
      ...v2.trace.scope,
      secondaries: [{ kind: 'family_chapter', chapter: '61', source: 'identify' }],
    };
    v2.trace.retrieval.secondary_candidate_counts = { family_chapter: 3 };
    const adapted = adaptV2ToPipelineResult(v2);
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    const classify = v1.trace.stages.find((s) => s.stage === 'classify')!;
    const retrievalAction = classify.actions.find((a) => a.action === 'multi_arm_retrieval')!;
    const stepNames = retrievalAction.steps?.map((s) => s.step) ?? [];
    expect(stepNames).toContain('retrieve_merchant_prefix');
    expect(stepNames).toContain('retrieve_family_chapter');
  });

  it('verifier_uncertain surfaces UNCERTAIN + rules_triggered in summary', () => {
    const v2 = buildResultV2();
    v2.trace.verify = {
      result: 'UNCERTAIN',
      rules_triggered: ['identify_chapter_disagreement'],
    };
    v2.classification_status = 'DRIFT';
    v2.hitl = { reason: 'verifier_uncertain', cleaned_description: 'cotton t-shirt' };
    const adapted = adaptV2ToPipelineResult(v2);
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.summary.verifier_result).toBe('UNCERTAIN');
    expect(v1.trace.summary.verifier_rules_triggered).toEqual([
      'identify_chapter_disagreement',
    ]);
  });

  it('picker escalate omits the verify action (verifier never ran)', () => {
    const escalatePick: PickEscalate = {
      kind: 'escalate',
      reason: 'no_candidate_fits',
      detail: 'all 12 candidates verdicted does_not_fit',
      trace: {
        llm_called: true,
        latency_ms: 4500,
        model: 'mock-sonnet',
        status: 'ok',
        candidate_count: 12,
        audit_flag: false,
      },
    };
    const v2 = buildResultV2();
    v2.trace.pick = escalatePick;
    v2.trace.verify = null;
    v2.trace.sanity = null;
    v2.final_code = null;
    v2.goods_description_ar = null;
    v2.sanity_verdict = null;
    v2.classification_status = 'ZERO_SIGNAL';
    v2.hitl = { reason: 'verdict_escalate', cleaned_description: 'cotton t-shirt' };
    const adapted = adaptV2ToPipelineResult(v2);
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    const classify = v1.trace.stages.find((s) => s.stage === 'classify')!;
    const actions = classify.actions.map((a) => a.action);
    expect(actions).not.toContain('verify');
    expect(v1.trace.summary.pick_escalate_reason).toBe('no_candidate_fits');
    expect(v1.status).toBe('failed');
  });

  it('countLlmCalls double-counts model-tagged steps under LLM actions (legacy convention)', () => {
    // countLlmCalls increments for every action with llm_used=true AND
    // for every nested step with a model field. v2 identify + pick each
    // emit (1 action + 1 model-tagged step) = 2 increments. submission +
    // sanity_check are bare LLM actions = 1 increment each. Total = 6.
    // PR 13 may revisit the counter to dedupe, but PR 12 keeps the
    // legacy semantics.
    const adapted = adaptV2ToPipelineResult(buildResultV2());
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: adapted,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.llm_calls_used).toBe(6);
  });
});
