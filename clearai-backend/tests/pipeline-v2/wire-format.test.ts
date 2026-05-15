/**
 * PR 12 — dispatch-v1 v2 branch tests (updated PR 13).
 *
 * PR 13: adaptV2ToPipelineResult (v2/adapter.ts) deleted; PipelineResult is
 * now canonical. Tests build PipelineResult directly and feed it into
 * assembleDispatchV1.
 *
 * Pure-function tests. No LLM, no DB, no orchestrator.
 */
import { describe, expect, it } from 'vitest';
import { assembleDispatchV1 } from '../../src/modules/pipeline/trace/dispatch-v1.js';
import type {
  IdentifyResult,
  MerchantResolution,
  MerchantResolutionTrace,
  PickAccepted,
  PickEscalate,
  PipelineResult,
  PipelineTrace,
  ScopeSelection,
  VerifierResult,
} from '../../src/modules/pipeline/types.js';
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

function buildResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  const trace: PipelineTrace = {
    parse: { merchant_code_state: 'twelve_digit' },
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

describe('assembleDispatchV1', () => {
  it('surfaces parse.merchant_code_state on the wire (twelve_digit case)', () => {
    const result = buildResult();
    result.trace.parse.merchant_code_state = 'twelve_digit';
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.summary.merchant_code_state).toBe('twelve_digit');
    const normalize = v1.trace.stages.find((s) => s.stage === 'normalize')!;
    const parseAction = normalize.actions.find((a) => a.action === 'parse')!;
    expect((parseAction.output as { merchant_code_state?: string })?.merchant_code_state).toBe('twelve_digit');
  });

  it('surfaces parse.merchant_code_state on the wire (short_prefix case)', () => {
    // Regression: pre-fix the v2 wire builder synthesised the state
    // from merchant_resolution.state, which lost the original length
    // bucket. A 10-digit code that lands as 'unknown' (not in codebook)
    // would have been mis-reported as 'twelve_digit'. The fix threads
    // the parse-stage classification through the trace and reads it
    // verbatim on the wire.
    const result = buildResult();
    result.trace.parse.merchant_code_state = 'short_prefix';
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result,
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.summary.merchant_code_state).toBe('short_prefix');
    const normalize = v1.trace.stages.find((s) => s.stage === 'normalize')!;
    const parseAction = normalize.actions.find((a) => a.action === 'parse')!;
    expect((parseAction.output as { merchant_code_state?: string })?.merchant_code_state).toBe('short_prefix');
  });

  it("emits pipeline_architecture='v2' on the summary", () => {
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: buildResult(),
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.summary.pipeline_architecture).toBe('v2');
  });

  it('populates v2-only summary fields (identify_pass, picked_from_arm, verifier_result)', () => {
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: buildResult(),
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

  it('nulls out legacy + anchored summary fields', () => {
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: buildResult(),
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.summary.description_classifier_top_fit).toBeNull();
    expect(v1.trace.summary.code_resolver_code).toBeNull();
    expect(v1.trace.summary.reconciliation).toBeNull();
  });

  it('emits the three top-level wire stages: normalize, classify, sanity', () => {
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: buildResult(),
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.stages.map((s) => s.stage)).toEqual(['normalize', 'classify', 'sanity']);
  });

  it('emits v2 actions inside classify in pipeline order', () => {
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: buildResult(),
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
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: buildResult(),
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
    const result = buildResult();
    result.trace = {
      ...result.trace,
      scope: {
        ...result.trace.scope,
        secondaries: [{ kind: 'family_chapter', chapter: '61', source: 'identify' }],
      },
      retrieval: {
        ...result.trace.retrieval,
        secondary_candidate_counts: { family_chapter: 3 },
      },
    };
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result,
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
    const result = buildResult({
      classification_status: 'DRIFT',
      hitl: { reason: 'verifier_uncertain', cleaned_description: 'cotton t-shirt' },
    });
    result.trace = {
      ...result.trace,
      verify: { result: 'UNCERTAIN', rules_triggered: ['identify_chapter_disagreement'] },
    };
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result,
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
    const result = buildResult({
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: null,
      classification_status: 'ZERO_SIGNAL',
      hitl: { reason: 'verdict_escalate', cleaned_description: 'cotton t-shirt' },
    });
    result.trace = {
      ...result.trace,
      pick: escalatePick,
      verify: null,
      sanity: null,
    };
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result,
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
    const v1 = assembleDispatchV1({
      itemId: 'item-1',
      operatorSlug: 'naqel',
      result: buildResult(),
      startedAt: '2026-05-15T10:00:00.000Z',
      completedAt: '2026-05-15T10:00:10.000Z',
    });
    expect(v1.trace.llm_calls_used).toBe(6);
  });
});
