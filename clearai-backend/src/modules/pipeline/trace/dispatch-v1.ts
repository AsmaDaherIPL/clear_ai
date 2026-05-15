/**
 * dispatch-v1 trace assembler — converts the canonical PipelineResult into
 * the structured three-level wire format (stage -> actions -> steps) the
 * SPA reads.
 *
 * Stage layout:
 *   normalize  -> actions: [parse]
 *   classify   -> actions: [identify, merchant_resolution, scope_selection,
 *                           multi_arm_retrieval, rerank, pick, verify,
 *                           submission_description]
 *   sanity     -> actions: [sanity_check]
 *
 * This module also exports `assembleCanonicalItem`, the wire-format
 * builder used by both /batches/{id}/items and /classifications/dispatch.
 */
import type {
  ClassificationStatus,
  DispatchV1Action,
  DispatchV1Outcome,
  DispatchV1Response,
  DispatchV1Stage,
  DispatchV1Step,
  DispatchV1StepName,
  DispatchV1Summary,
  DispatchV1Trace,
  SanityVerdict,
} from '../shared/pipeline.types.js';
import type {
  PipelineResult,
  PipelineTrace,
  PickAccepted,
  PickEscalate,
  IdentifyResult,
  ScopeSelection,
  MerchantResolution,
  VerifierResult,
} from '../types.js';

interface AssembleParams {
  itemId: string;
  operatorSlug: string;
  result: PipelineResult;
  /** Wall-clock start of the run (orchestrator entry). */
  startedAt: string;
  /** Wall-clock completion (after the route handler receives the result). */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Normalize stage builder (v2 path — parse is deterministic, no flat StageTrace)
// ---------------------------------------------------------------------------

function buildNormalizeStage(trace: PipelineTrace): DispatchV1Stage {
  const merchantState = trace.merchant_resolution.resolution.state;
  const merchantCodeState =
    merchantState === 'absent' ? 'absent'
    : merchantState === 'malformed' ? 'malformed'
    : 'twelve_digit';

  return {
    stage: 'normalize',
    started_at: new Date().toISOString(),
    duration_ms: 0,
    outcome: 'ok',
    actions: [{
      action: 'parse',
      duration_ms: 0,
      outcome: 'ok',
      llm_used: false,
      output: { merchant_code_state: merchantCodeState },
    }],
    output: {
      rejected: false,
      merchant_code_state: merchantCodeState,
    },
  };
}

// ---------------------------------------------------------------------------
// Classify stage action builders
// ---------------------------------------------------------------------------

function buildIdentifyAction(identify: IdentifyResult): DispatchV1Action {
  const steps: DispatchV1Step[] = [];
  if (identify.trace.llm_called) {
    steps.push({
      step: 'identify_llm',
      duration_ms: identify.trace.latency_ms,
      outcome: identify.trace.status === 'ok' ? 'ok'
        : identify.trace.status === 'skipped' ? 'skipped'
        : 'failed',
      ...(identify.trace.model ? { model: identify.trace.model } : {}),
      output: {},
    });
  }
  if (identify.trace.web_search_used) {
    steps.push({
      step: 'identify_web_search',
      duration_ms: 0,
      outcome: 'ok',
      output: {},
    });
  }

  const output: Record<string, unknown> = {
    pass: identify.trace.pass,
    kind: identify.kind,
    ...(identify.kind === 'clean_product'
      ? {
          canonical: identify.canonical,
          family_chapter: identify.family_chapter,
          identity_tokens: identify.identity_tokens,
          confidence: identify.confidence,
          evidence: identify.evidence,
          ...(identify.trace.evidence_mismatch ? { evidence_mismatch: true } : {}),
        }
      : identify.kind === 'multi_product'
        ? { products: identify.products }
        : { reason: identify.reason, cause: identify.cause }),
  };

  return {
    action: 'identify',
    duration_ms: identify.trace.latency_ms,
    outcome: identify.trace.status === 'ok' ? 'ok'
      : identify.trace.status === 'skipped' ? 'skipped'
      : 'failed',
    llm_used: identify.trace.llm_called,
    merchant_code_visible_to_model: false,
    steps,
    output,
  };
}

function buildMerchantResolutionAction(
  resolution: MerchantResolution,
  resolutionTrace: PipelineTrace['merchant_resolution']['trace'],
): DispatchV1Action {
  const output: Record<string, unknown> = {
    state: resolution.state,
    ...('resolved_code' in resolution && resolution.resolved_code
      ? { resolved_code: resolution.resolved_code }
      : {}),
    ...('source_code' in resolution && resolution.source_code
      ? { source_code: resolution.source_code }
      : {}),
    override_attempted: resolutionTrace.override_attempted,
    override_matched: resolutionTrace.override_matched,
  };
  return {
    action: 'merchant_resolution',
    duration_ms: resolutionTrace.latency_ms,
    outcome: 'ok',
    llm_used: resolutionTrace.llm_called,
    merchant_code_visible_to_model: true,
    output,
  };
}

function buildScopeSelectionAction(scope: ScopeSelection): DispatchV1Action {
  return {
    action: 'scope_selection',
    duration_ms: 0,
    outcome: 'ok',
    llm_used: false,
    output: {
      primary: scope.primary,
      secondaries: scope.secondaries,
      audit_flags: scope.audit_flags,
    },
  };
}

function retrievalStepNameForArm(
  kind: ScopeSelection['primary']['kind'] | ScopeSelection['secondaries'][number]['kind'],
): DispatchV1StepName | null {
  switch (kind) {
    case 'merchant_prefix': return 'retrieve_merchant_prefix';
    case 'family_chapter': return 'retrieve_family_chapter';
    case 'unconstrained': return 'retrieve_unconstrained';
    case 'lexical_tokens': return 'retrieve_lexical_tokens';
    case 'escalate': return null;
    default: return null;
  }
}

function buildMultiArmRetrievalAction(
  retrieval: PipelineTrace['retrieval'],
  scope: ScopeSelection,
): DispatchV1Action {
  const steps: DispatchV1Step[] = [];
  const primaryStepName = retrievalStepNameForArm(scope.primary.kind);
  if (primaryStepName) {
    steps.push({
      step: primaryStepName,
      duration_ms: 0,
      outcome: 'ok',
      output: { candidate_count: retrieval.primary_candidate_count },
    });
  }
  for (const arm of scope.secondaries) {
    const stepName = retrievalStepNameForArm(arm.kind);
    if (!stepName) continue;
    steps.push({
      step: stepName,
      duration_ms: 0,
      outcome: 'ok',
      output: { candidate_count: retrieval.secondary_candidate_counts[arm.kind] ?? 0 },
    });
  }
  return {
    action: 'multi_arm_retrieval',
    duration_ms: 0,
    outcome: 'ok',
    llm_used: false,
    output: {
      candidates_before_rerank: retrieval.candidates_before_rerank,
      primary_candidate_count: retrieval.primary_candidate_count,
      secondary_candidate_counts: retrieval.secondary_candidate_counts,
    },
    steps,
  };
}

function buildRerankAction(retrieval: PipelineTrace['retrieval']): DispatchV1Action {
  return {
    action: 'rerank',
    duration_ms: 0,
    outcome: 'ok',
    llm_used: false,
    output: {
      candidates_before_rerank: retrieval.candidates_before_rerank,
      candidates_after_rerank: retrieval.candidates_after_rerank,
    },
  };
}

function buildPickAction(pick: PickAccepted | PickEscalate): DispatchV1Action {
  const steps: DispatchV1Step[] = [{
    step: 'pick_retrieval',
    duration_ms: 0,
    outcome: pick.trace.candidate_count > 0 ? 'ok' : 'skipped',
    output: { candidate_count: pick.trace.candidate_count },
  }];
  if (pick.trace.llm_called) {
    const outcome: DispatchV1Outcome =
      pick.trace.status === 'ok' ? 'ok'
      : pick.trace.status === 'skipped' ? 'skipped'
      : 'failed';
    steps.push({
      step: 'pick_llm',
      duration_ms: pick.trace.latency_ms,
      outcome,
      ...(pick.trace.model ? { model: pick.trace.model } : {}),
      output: {},
    });
  }

  const output: Record<string, unknown> = pick.kind === 'accepted'
    ? {
        kind: pick.kind,
        final_code: pick.final_code,
        fit: pick.fit,
        confidence: pick.confidence,
        gir_applied: pick.gir_applied,
        verdict_population: pick.verdict_population,
        picked_from_arm: pick.picked_from_arm,
        merchant_chapter_disagreement: pick.merchant_chapter_disagreement,
        candidate_count_by_arm: pick.candidate_count_by_arm,
        audit_flag: pick.trace.audit_flag,
      }
    : {
        kind: pick.kind,
        reason: pick.reason,
        detail: pick.detail,
        audit_flag: pick.trace.audit_flag,
      };

  return {
    action: 'pick',
    duration_ms: pick.trace.latency_ms,
    outcome: pick.trace.status === 'ok' ? 'ok'
      : pick.trace.status === 'skipped' ? 'skipped'
      : 'failed',
    llm_used: pick.trace.llm_called,
    merchant_code_visible_to_model: false,
    steps,
    output,
  };
}

function buildVerifyAction(verify: VerifierResult): DispatchV1Action {
  return {
    action: 'verify',
    duration_ms: 0,
    outcome: 'ok',
    llm_used: false,
    output: {
      result: verify.result,
      rules_triggered: verify.rules_triggered,
    },
  };
}

function buildSubmissionAction(result: PipelineResult): DispatchV1Action | null {
  if (result.goods_description_ar === null) return null;
  return {
    action: 'submission_description',
    duration_ms: 0,
    outcome: 'ok',
    llm_used: true,
    output: { description_ar: result.goods_description_ar },
  };
}

function buildClassifyStage(trace: PipelineTrace, result: PipelineResult): DispatchV1Stage {
  const actions: DispatchV1Action[] = [];

  actions.push(buildIdentifyAction(trace.identify));
  actions.push(buildMerchantResolutionAction(
    trace.merchant_resolution.resolution,
    trace.merchant_resolution.trace,
  ));
  actions.push(buildScopeSelectionAction(trace.scope));
  actions.push(buildMultiArmRetrievalAction(trace.retrieval, trace.scope));
  actions.push(buildRerankAction(trace.retrieval));
  actions.push(buildPickAction(trace.pick));
  if (trace.verify) actions.push(buildVerifyAction(trace.verify));
  const sub = buildSubmissionAction(result);
  if (sub) actions.push(sub);

  const stageOutput: Record<string, unknown> = trace.pick.kind === 'accepted'
    ? {
        final_code: trace.pick.final_code,
        fit: trace.pick.fit,
        confidence: trace.pick.confidence,
        verifier_result: trace.verify?.result ?? null,
        goods_description_ar: result.goods_description_ar,
      }
    : {
        escalate_reason: trace.pick.reason,
        escalate_detail: trace.pick.detail,
      };

  return {
    stage: 'classify',
    started_at: new Date().toISOString(),
    duration_ms: actions.reduce((acc, a) => acc + a.duration_ms, 0),
    outcome: actions.some((a) => a.outcome === 'failed') ? 'failed' : 'ok',
    actions,
    output: stageOutput,
  };
}

function buildSanityStage(trace: PipelineTrace): DispatchV1Stage | null {
  const sanity = trace.sanity;
  if (!sanity) return null;
  const sanityOutput = {
    verdict: sanity.verdict,
    rationale: sanity.rationale,
    ...(sanity.degraded ? { degraded: true } : {}),
    ...(sanity.attempts !== undefined ? { attempts: sanity.attempts } : {}),
    ...(sanity.retried_reasons && sanity.retried_reasons.length > 0
      ? { retried_reasons: sanity.retried_reasons }
      : {}),
  };
  return {
    stage: 'sanity',
    started_at: new Date().toISOString(),
    duration_ms: sanity.latency_ms ?? 0,
    outcome: 'ok',
    actions: [{
      action: 'sanity_check',
      duration_ms: sanity.latency_ms ?? 0,
      outcome: 'ok',
      llm_used: true,
      output: sanityOutput,
    }],
    output: sanityOutput,
  };
}

function buildSummary(
  trace: PipelineTrace,
  result: PipelineResult,
): DispatchV1Summary {
  const pickAccepted = trace.pick.kind === 'accepted' ? trace.pick : null;
  const merchantState = trace.merchant_resolution.resolution.state;
  const merchantCodeState =
    merchantState === 'absent' ? 'absent'
    : merchantState === 'malformed' ? 'malformed'
    : 'twelve_digit';

  return {
    merchant_code_state: merchantCodeState as DispatchV1Summary['merchant_code_state'],
    // Legacy + anchored fields removed (PR 13).
    description_classifier_top_fit: null,
    code_resolver_code: null,
    reconciliation: null,
    operator_override_applied: trace.merchant_resolution.trace.override_matched,
    identify_kind: trace.identify.kind,
    scope_kind: trace.scope.primary.kind,
    pick_fit: pickAccepted?.fit ?? null,
    pick_escalate_reason: trace.pick.kind === 'escalate' ? trace.pick.reason : null,
    identify_pass: trace.identify.trace.pass,
    picked_from_arm: pickAccepted?.picked_from_arm ?? null,
    merchant_chapter_disagreement: pickAccepted?.merchant_chapter_disagreement ?? null,
    secondary_arm_count: trace.scope.secondaries.length,
    candidate_count_by_arm: pickAccepted?.candidate_count_by_arm ?? null,
    verifier_result: trace.verify?.result ?? null,
    verifier_rules_triggered: trace.verify?.rules_triggered ?? null,
    final_code: result.final_code,
    sanity_verdict: trace.sanity?.verdict ?? result.sanity_verdict ?? null,
    // pipeline_architecture kept for wire-format compatibility; always 'v2'.
    pipeline_architecture: 'v2',
  };
}

/** Crude LLM-call counter. */
function countLlmCalls(stages: DispatchV1Stage[]): number {
  let n = 0;
  for (const s of stages) {
    for (const a of s.actions) {
      if (a.llm_used) n += 1;
      for (const step of a.steps ?? []) {
        if (step.model) n += 1;
      }
    }
  }
  return n;
}

export function assembleDispatchV1(params: AssembleParams): DispatchV1Response {
  const { itemId, operatorSlug, result, startedAt, completedAt } = params;
  const trace = result.trace;
  const stages: DispatchV1Stage[] = [];

  stages.push(buildNormalizeStage(trace));
  stages.push(buildClassifyStage(trace, result));
  const sanity = buildSanityStage(trace);
  if (sanity) stages.push(sanity);

  const status: DispatchV1Response['status'] =
    result.final_code !== null
      ? 'succeeded'
      : result.sanity_verdict === 'BLOCK'
        ? 'rejected'
        : 'failed';

  const summary = buildSummary(trace, result);

  const v1Trace: DispatchV1Trace = {
    trace_version: 'dispatch-v1',
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    llm_calls_used: countLlmCalls(stages),
    summary,
    stages,
  };

  return {
    item_id: itemId,
    operator_slug: operatorSlug,
    status,
    final_code: result.final_code,
    goods_description_ar: result.goods_description_ar,
    goods_description_en: null,
    sanity_verdict: result.sanity_verdict ?? 'PASS',
    trace: v1Trace,
  };
}

// ---------------------------------------------------------------------------
// Canonical wire shape helpers
// ---------------------------------------------------------------------------

export interface LocalizedString {
  language: 'en' | 'ar';
  value: string | null;
}

export interface DeclaredValue {
  hs_code: string | null;
  description: string | null;
  amount: number | null;
  currency: string | null;
}

export interface ResolvedHsCodeDescription {
  full_hierarchy: LocalizedString[];
  zatca_submission_description: LocalizedString[];
  retrieval_query: string | null;
}

export interface CanonicalValueAmount {
  value: number | null;
  currency: string | null;
}

export interface CanonicalValue {
  amount: CanonicalValueAmount;
  rate: number | null;
  rate_as_of: string | null;
}

export interface CanonicalClassificationResult {
  resolved_hs_code: string | null;
  classification_status: ClassificationStatus | null;
  classification_confidence: number | null;
  sanity_verdict: SanityVerdict | null;
}

export interface CanonicalItem {
  id: string;
  row_index?: number;
  declared_value: DeclaredValue;
  resolved_hs_code_description: ResolvedHsCodeDescription;
  value: CanonicalValue;
  duty_info: unknown | null;
  procedures: unknown[];
  classification_result: CanonicalClassificationResult;
  trace?: DispatchV1Trace | Record<string, unknown> | null;
  error: string | null;
}

export interface AssembleCanonicalParams {
  id: string;
  rowIndex?: number;
  declared: DeclaredValue;
  resolvedHsCode: string | null;
  catalogPathEn: string | null;
  catalogPathAr: string | null;
  submissionDescriptionAr: string | null;
  submissionDescriptionEn: string | null;
  retrievalQuery: string | null;
  valueSar: { amount: number | null; currency: string | null };
  fxRate: number | null;
  fxRateAsOf: string | null;
  dutyInfo: unknown | null;
  procedures: unknown[];
  classificationStatus: ClassificationStatus | null;
  classificationConfidence: number | null;
  sanityVerdict: SanityVerdict | null;
  trace?: DispatchV1Trace | Record<string, unknown> | null;
  error: string | null;
  includeTrace: boolean;
}

export function assembleCanonicalItem(params: AssembleCanonicalParams): CanonicalItem {
  const base: CanonicalItem = {
    id: params.id,
    ...(params.rowIndex !== undefined ? { row_index: params.rowIndex } : {}),
    declared_value: params.declared,
    resolved_hs_code_description: {
      full_hierarchy: [
        { language: 'en', value: params.catalogPathEn },
        { language: 'ar', value: params.catalogPathAr },
      ],
      zatca_submission_description: [
        { language: 'en', value: params.submissionDescriptionEn },
        { language: 'ar', value: params.submissionDescriptionAr },
      ],
      retrieval_query: params.retrievalQuery,
    },
    value: {
      amount: { value: params.valueSar.amount, currency: params.valueSar.currency },
      rate: params.fxRate,
      rate_as_of: params.fxRateAsOf,
    },
    duty_info: params.dutyInfo,
    procedures: params.procedures,
    classification_result: {
      resolved_hs_code: params.resolvedHsCode,
      classification_status: params.classificationStatus,
      classification_confidence: params.classificationConfidence,
      sanity_verdict: params.sanityVerdict,
    },
    error: params.error,
  };
  if (params.includeTrace) {
    base.trace = params.trace ?? null;
  }
  return base;
}

/**
 * Pull a retrieval_query string out of a PipelineTrace.
 * identify.canonical when clean_product, else null.
 */
export function retrievalQueryFromTrace(trace: PipelineTrace): string | null {
  return trace.identify.kind === 'clean_product' ? trace.identify.canonical : null;
}

/**
 * Derive ClassificationStatus from a PipelineTrace.
 */
export function classificationStatusFromTrace(trace: PipelineTrace): ClassificationStatus | null {
  if (trace.pick.kind === 'escalate') return 'ZERO_SIGNAL';
  if (trace.verify?.result === 'UNCERTAIN') return 'DRIFT';
  if (trace.identify.kind === 'clean_product' && trace.pick.fit === 'fits') return 'AGREEMENT';
  return 'DRIFT';
}

/**
 * Pull a confidence score out of a PipelineTrace.
 */
export function classificationConfidenceFromTrace(trace: PipelineTrace): number | null {
  return trace.pick.kind === 'accepted' ? trace.pick.confidence : null;
}
