/**
 * dispatch-v1 trace assembler — converts the orchestrator's flat
 * `StageTrace[]` + Track A/B/Verdict/Sanity outputs into the structured
 * three-level wire format (stage → actions → steps) the SPA reads.
 *
 * The orchestrator and Track A continue to emit the legacy flat trace
 * during execution; this module reshapes it at the route boundary so
 * the rename is non-invasive to the algorithm code.
 *
 * Stage layout:
 *   normalize  → actions: [parse, cleanup]
 *   classify   → actions: [description_classifier, code_resolver,
 *                          reconciliation, submission_description]
 *   sanity     → actions: [sanity_check]
 *
 * This module also exports `assembleCanonicalItem`, the wire-format
 * builder used by both /batches/{id}/items and /classifications/dispatch.
 * `DispatchV1Response` remains for internal recorders that read the
 * three-level trace shape; the canonical item is what ships to the SPA.
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
  PipelineResult,
  PipelineTrace,
  SanityVerdict,
  StageTrace,
  DescriptionClassifierResult,
  CodeResolverResult,
} from '../shared/pipeline.types.js';

// Legacy stage name → new step name. Track A's substages all start with
// "track-a/"; we strip the prefix and map to the canonical step enum.
const TRACK_A_STEP_MAP: Record<string, DispatchV1StepName> = {
  researcher: 'researcher',
  retrieval: 'retrieval',
  threshold: 'threshold',
  'web-researcher': 'web_researcher',
  'retrieval-after-web': 'retrieval_after_web',
  'threshold-after-web': 'threshold_after_web',
  picker: 'picker',
};

interface AssembleParams {
  itemId: string;
  operatorSlug: string;
  result: PipelineResult;
  /** Wall-clock start of the run (orchestrator entry). */
  startedAt: string;
  /** Wall-clock completion (after the route handler receives the result). */
  completedAt: string;
}

/** Pull a stage by its legacy name; returns the first match or undefined. */
function findStage(stages: StageTrace[], name: string): StageTrace | undefined {
  return stages.find((s) => s.name === name);
}

/** Total duration across a list of stages. */
function sumDuration(stages: StageTrace[]): number {
  return stages.reduce((acc, s) => acc + s.duration_ms, 0);
}

/** Map legacy outcome strings to dispatch-v1 outcome enum. */
function mapOutcome(s: StageTrace | undefined): DispatchV1Outcome {
  if (!s) return 'skipped';
  if (s.outcome === 'ok') {
    // Threshold stages encode pass/fail in detail.passed; surface as failed_gate.
    const detail = s.detail as { passed?: boolean } | undefined;
    if (detail && detail.passed === false) return 'failed_gate';
    return 'ok';
  }
  return s.outcome === 'failed' ? 'failed' : 'skipped';
}

function buildNormalizeStage(stages: StageTrace[]): DispatchV1Stage {
  const parse = findStage(stages, 'stage-0a/parse');
  const cleanup = findStage(stages, 'stage-0b/cleanup');

  const actions: DispatchV1Action[] = [];
  if (parse) {
    actions.push({
      action: 'parse',
      duration_ms: parse.duration_ms,
      outcome: mapOutcome(parse),
      llm_used: false,
      output: (parse.detail as Record<string, unknown>) ?? {},
    });
  }
  if (cleanup) {
    actions.push({
      action: 'cleanup',
      duration_ms: cleanup.duration_ms,
      outcome: mapOutcome(cleanup),
      llm_used: true,
      output: (cleanup.detail as Record<string, unknown>) ?? {},
    });
  }

  const startedAt = parse?.started_at ?? cleanup?.started_at ?? new Date().toISOString();
  return {
    stage: 'normalize',
    started_at: startedAt,
    duration_ms: sumDuration([parse, cleanup].filter((s): s is StageTrace => !!s)),
    outcome: actions.some((a) => a.outcome === 'failed') ? 'failed' : 'ok',
    actions,
    output: {
      cleanup_clarity_verdict: (cleanup?.detail as { clarity_verdict?: string })?.clarity_verdict ?? null,
      rejected: (parse?.detail as { rejected?: boolean })?.rejected ?? false,
    },
  };
}

function buildDescriptionClassifierAction(
  stages: StageTrace[],
  trackA: DescriptionClassifierResult | null,
): DispatchV1Action | null {
  // Pull all track-a/* stages in original order.
  const trackAStages = stages.filter((s) => s.name.startsWith('track-a/'));
  if (trackAStages.length === 0 && !trackA) return null;

  const steps: DispatchV1Step[] = [];
  for (const s of trackAStages) {
    const suffix = s.name.replace(/^track-a\//, '');
    const stepName = TRACK_A_STEP_MAP[suffix];
    if (!stepName) continue;
    const detail = (s.detail as Record<string, unknown>) ?? {};
    const model = typeof detail.model === 'string' ? (detail.model as string) : undefined;
    steps.push({
      step: stepName,
      duration_ms: s.duration_ms,
      outcome: mapOutcome(s),
      ...(model ? { model } : {}),
      output: detail,
    });
  }

  return {
    action: 'description_classifier',
    duration_ms: sumDuration(trackAStages),
    outcome: trackAStages.some((s) => mapOutcome(s) === 'failed') ? 'failed' : 'ok',
    merchant_code_visible_to_model: false,
    steps,
    output: trackA
      ? {
          annotated_candidates: trackA.annotated_candidates,
          threshold_failed: trackA.threshold_failed,
          no_fit: trackA.no_fit,
          interpretation_stage: trackA.interpretation_stage,
          effective_description: trackA.effective_description,
          picker_confidence: trackA.picker_confidence,
        }
      : {},
  };
}

function buildCodeResolverAction(
  trackB: CodeResolverResult | null,
): DispatchV1Action | null {
  if (!trackB) return null;
  return {
    action: 'code_resolver',
    duration_ms: 0,
    outcome: 'ok',
    merchant_code_visible_to_model: true,
    input: {
      raw_merchant_code: trackB.raw_merchant_code,
      codebook_state: trackB.codebook_state,
      override_applied: trackB.override_applied,
      override_target_code: trackB.override_target_code,
    },
    output: {
      resolved_code: trackB.resolved_code,
      resolution: trackB.resolution,
      raw_merchant_code: trackB.raw_merchant_code,
      codebook_state: trackB.codebook_state,
      override_applied: trackB.override_applied,
      override_target_code: trackB.override_target_code,
      // PR 5: subtree consistency check, surfaced for the UI and reconciliation.
      consistency_verdict: trackB.consistency_verdict,
      valid_prefix: trackB.valid_prefix,
      subtree_candidates: trackB.subtree_candidates,
      ...(trackB.llm_context ? { llm_context: trackB.llm_context } : {}),
    },
  };
}

function buildReconciliationAction(
  stages: StageTrace[],
  trace: PipelineTrace,
): DispatchV1Action | null {
  const stage = findStage(stages, 'stage-2/reconciliation');
  if (!stage && !trace.verdict) return null;
  const verdict = trace.verdict;
  const sourceMap: Record<string, DispatchV1Summary['reconciliation']> = {
    track_a: 'description_classifier',
    track_b: 'code_resolver',
    reconciled: 'reconciled',
  };
  const output: Record<string, unknown> = verdict
    ? verdict.decision === 'accept'
      ? {
          decision: verdict.decision,
          final_code: verdict.final_code,
          // V1 surface: AGREEMENT | DRIFT | ZERO_SIGNAL. The SPA reads this
          // as the single answer to "did the tracks agree?".
          classification_status: verdict.classification_status,
          source: sourceMap[verdict.source] ?? verdict.source,
          rationale: verdict.rationale,
        }
      : {
          decision: verdict.decision,
          classification_status: verdict.classification_status,
          disagreement_summary: verdict.disagreement_summary,
        }
    : {};

  return {
    action: 'reconciliation',
    duration_ms: stage?.duration_ms ?? 0,
    outcome: mapOutcome(stage),
    llm_used: false,
    output,
  };
}

function buildSubmissionDescriptionAction(
  stages: StageTrace[],
  result: PipelineResult,
): DispatchV1Action | null {
  const stage = findStage(stages, 'stage-2.5/submission-description');
  if (!stage) return null;
  const detail = (stage.detail as Record<string, unknown>) ?? {};
  // Cache hits and deterministic fallbacks don't actually call the LLM;
  // only sources of 'llm' / 'llm_failed' touch Foundry.
  const source = typeof detail.source === 'string' ? detail.source : null;
  const llmUsed = source === 'llm' || source === 'llm_failed';
  return {
    action: 'submission_description',
    duration_ms: stage.duration_ms,
    outcome: mapOutcome(stage),
    llm_used: llmUsed,
    output: {
      description_ar: result.goods_description_ar,
      source: source,
      length: detail.length ?? null,
    },
  };
}

function buildClassifyStageLegacy(
  stages: StageTrace[],
  trace: PipelineTrace,
  result: PipelineResult,
): DispatchV1Stage {
  const actions: DispatchV1Action[] = [];
  const dc = buildDescriptionClassifierAction(stages, trace.track_a);
  if (dc) actions.push(dc);
  const cr = buildCodeResolverAction(trace.track_b);
  if (cr) actions.push(cr);
  const rec = buildReconciliationAction(stages, trace);
  if (rec) actions.push(rec);
  const sub = buildSubmissionDescriptionAction(stages, result);
  if (sub) actions.push(sub);

  const trackAStages = stages.filter((s) => s.name.startsWith('track-a/'));
  const startedAt =
    trackAStages[0]?.started_at ??
    findStage(stages, 'stage-2/reconciliation')?.started_at ??
    new Date().toISOString();

  const verdict = trace.verdict;
  const verdictOutput: Record<string, unknown> = verdict
    ? verdict.decision === 'accept'
      ? {
          final_code: verdict.final_code,
          decision: verdict.decision,
          source: verdict.source,
          goods_description_ar: result.goods_description_ar,
        }
      : {
          decision: verdict.decision,
          disagreement_summary: verdict.disagreement_summary,
        }
    : {};

  return {
    stage: 'classify',
    started_at: startedAt,
    duration_ms: actions.reduce((acc, a) => acc + a.duration_ms, 0),
    outcome: actions.some((a) => a.outcome === 'failed') ? 'failed' : 'ok',
    actions,
    output: verdictOutput,
  };
}

// ---------------------------------------------------------------------------
// Anchored classify-stage builders (PR-A-5)
// ---------------------------------------------------------------------------

/** Build the `identify` action under anchored. Sources data from
 *  trace.anchored_identify (typed result) and stage-1/identify (timing/detail). */
function buildIdentifyAction(
  stages: StageTrace[],
  trace: PipelineTrace,
): DispatchV1Action | null {
  const stage = findStage(stages, 'stage-1/identify');
  const identify = trace.anchored_identify;
  if (!stage && !identify) return null;

  const detail = (stage?.detail as Record<string, unknown> | undefined) ?? {};
  const llmUsed = identify?.trace.llm_called ?? false;
  const webUsed = identify?.trace.web_search_used ?? false;

  // Surface a single LLM step (and a separate web_search step when used)
  // so per-step timing / model attribution lives at the same granularity
  // as legacy track-A. Both share the action total when individual
  // timings aren't separately tracked.
  const steps: DispatchV1Step[] = [];
  if (llmUsed) {
    steps.push({
      step: 'identify_llm',
      duration_ms: identify?.trace.latency_ms ?? 0,
      outcome: identify?.trace.status === 'ok' ? 'ok' : identify?.trace.status === 'skipped' ? 'skipped' : 'failed',
      ...(identify?.trace.model ? { model: identify.trace.model } : {}),
      output: {},
    });
  }
  if (webUsed) {
    steps.push({
      step: 'identify_web_search',
      // identify.ts does not separately track web-search latency; surface 0
      // and let the parent action carry the total.
      duration_ms: 0,
      outcome: 'ok',
      output: {},
    });
  }

  const output: Record<string, unknown> = identify
    ? identify.kind === 'clean_product'
      ? {
          kind: identify.kind,
          canonical: identify.canonical,
          family_chapter: identify.family_chapter,
          identity_tokens: identify.identity_tokens,
          confidence: identify.confidence,
          evidence: identify.evidence,
          ...(identify.trace.evidence_mismatch ? { evidence_mismatch: true } : {}),
        }
      : identify.kind === 'multi_product'
        ? { kind: identify.kind, products: identify.products }
        : { kind: identify.kind, reason: identify.reason, cause: identify.cause }
    : detail;

  return {
    action: 'identify',
    duration_ms: stage?.duration_ms ?? identify?.trace.latency_ms ?? 0,
    outcome: mapOutcome(stage),
    llm_used: llmUsed,
    // Identify is deliberately blinded to the merchant code (anchoring-
    // avoidance rationale). Surface that invariant on the wire so the
    // SPA can show a "blind to merchant code" badge.
    merchant_code_visible_to_model: false,
    steps,
    output,
  };
}

/** Build the `constrain` action under anchored. */
function buildConstrainAction(
  stages: StageTrace[],
  trace: PipelineTrace,
): DispatchV1Action | null {
  const stage = findStage(stages, 'stage-2/constrain');
  const constrain = trace.anchored_constrain;
  if (!stage && !constrain) return null;

  // Steps mirror the deterministic walk: codebook lookup → override
  // lookup → scope selection. Each step has a fixed outcome derived
  // from constrain.trace flags. constrain.ts does not break out
  // per-step latency, so durations are 0 and parent action carries total.
  const steps: DispatchV1Step[] = [];
  if (constrain) {
    steps.push({
      step: 'constrain_codebook_walk',
      duration_ms: 0,
      outcome: 'ok',
      output: {
        resolution_state: constrain.resolution.state,
      },
    });
    if (constrain.trace.override_attempted) {
      steps.push({
        step: 'constrain_override_lookup',
        duration_ms: 0,
        outcome: constrain.trace.override_matched ? 'ok' : 'skipped',
        output: { matched: constrain.trace.override_matched },
      });
    }
    steps.push({
      step: 'constrain_scope_select',
      duration_ms: 0,
      outcome: 'ok',
      output: { scope_kind: constrain.scope.kind },
    });
  }

  const output: Record<string, unknown> = constrain
    ? {
        resolution: constrain.resolution,
        scope: constrain.scope,
        override_attempted: constrain.trace.override_attempted,
        override_matched: constrain.trace.override_matched,
      }
    : ((stage?.detail as Record<string, unknown>) ?? {});

  return {
    action: 'constrain',
    duration_ms: stage?.duration_ms ?? constrain?.trace.latency_ms ?? 0,
    outcome: mapOutcome(stage),
    llm_used: constrain?.trace.llm_called ?? false,
    // Constrain reads the merchant code (deterministic codebook walk +
    // override table). Surface for SPA badge.
    merchant_code_visible_to_model: true,
    steps,
    output,
  };
}

/** Build the `pick` action under anchored. */
function buildPickAction(
  stages: StageTrace[],
  trace: PipelineTrace,
): DispatchV1Action | null {
  const stage = findStage(stages, 'stage-3/pick');
  const pick = trace.anchored_pick;
  if (!stage && !pick) return null;

  const steps: DispatchV1Step[] = [];
  if (pick) {
    steps.push({
      step: 'pick_retrieval',
      duration_ms: 0,
      outcome: pick.trace.candidate_count > 0 ? 'ok' : 'skipped',
      output: { candidate_count: pick.trace.candidate_count },
    });
    if (pick.trace.llm_called) {
      const status = pick.trace.status;
      const outcome: DispatchV1Outcome =
        status === 'ok' ? 'ok'
        : status === 'skipped' ? 'skipped'
        : 'failed';
      steps.push({
        step: 'pick_llm',
        duration_ms: pick.trace.latency_ms,
        outcome,
        ...(pick.trace.model ? { model: pick.trace.model } : {}),
        output: {},
      });
    }
  }

  const output: Record<string, unknown> = pick
    ? pick.kind === 'accepted'
      ? {
          kind: pick.kind,
          final_code: pick.final_code,
          fit: pick.fit,
          confidence: pick.confidence,
          gir_applied: pick.gir_applied,
          verdict_population: pick.verdict_population,
          audit_flag: pick.trace.audit_flag,
        }
      : {
          kind: pick.kind,
          reason: pick.reason,
          detail: pick.detail,
          audit_flag: pick.trace.audit_flag,
        }
    : ((stage?.detail as Record<string, unknown>) ?? {});

  return {
    action: 'pick',
    duration_ms: stage?.duration_ms ?? pick?.trace.latency_ms ?? 0,
    outcome: mapOutcome(stage),
    llm_used: pick?.trace.llm_called ?? false,
    // Pick sees the scope (constrain's merchant-code-derived prefix) but
    // not the merchant code itself, by construction. Same blindness as
    // legacy picker.
    merchant_code_visible_to_model: false,
    steps,
    output,
  };
}

function buildClassifyStageAnchored(
  stages: StageTrace[],
  trace: PipelineTrace,
  result: PipelineResult,
): DispatchV1Stage {
  const actions: DispatchV1Action[] = [];
  const id = buildIdentifyAction(stages, trace);
  if (id) actions.push(id);
  const cn = buildConstrainAction(stages, trace);
  if (cn) actions.push(cn);
  const pk = buildPickAction(stages, trace);
  if (pk) actions.push(pk);
  // Submission description stage name differs under anchored
  // (`stage-4/submission-description` vs legacy
  // `stage-2.5/submission-description`); buildAnchoredSubmissionAction
  // handles that.
  const sub = buildAnchoredSubmissionAction(stages, result);
  if (sub) actions.push(sub);

  const startedAt =
    findStage(stages, 'stage-1/identify')?.started_at ??
    findStage(stages, 'stage-2/constrain')?.started_at ??
    new Date().toISOString();

  const pick = trace.anchored_pick;
  const stageOutput: Record<string, unknown> = pick
    ? pick.kind === 'accepted'
      ? {
          final_code: pick.final_code,
          fit: pick.fit,
          confidence: pick.confidence,
          goods_description_ar: result.goods_description_ar,
        }
      : {
          escalate_reason: pick.reason,
          escalate_detail: pick.detail,
        }
    : {};

  return {
    stage: 'classify',
    started_at: startedAt,
    duration_ms: actions.reduce((acc, a) => acc + a.duration_ms, 0),
    outcome: actions.some((a) => a.outcome === 'failed') ? 'failed' : 'ok',
    actions,
    output: stageOutput,
  };
}

/** Anchored submission_description action — same shape as legacy, but
 *  reads the anchored stage name (`stage-4/submission-description`). */
function buildAnchoredSubmissionAction(
  stages: StageTrace[],
  result: PipelineResult,
): DispatchV1Action | null {
  const stage = findStage(stages, 'stage-4/submission-description');
  if (!stage) return null;
  const detail = (stage.detail as Record<string, unknown>) ?? {};
  const source = typeof detail.source === 'string' ? detail.source : null;
  const llmUsed = source === 'llm' || source === 'llm_failed';
  return {
    action: 'submission_description',
    duration_ms: stage.duration_ms,
    outcome: mapOutcome(stage),
    llm_used: llmUsed,
    output: {
      description_ar: result.goods_description_ar,
      source,
      length: detail.length ?? null,
    },
  };
}

function buildSanityStage(
  stages: StageTrace[],
  trace: PipelineTrace,
): DispatchV1Stage | null {
  // Legacy emits `stage-3/sanity`; anchored emits `stage-5/sanity`.
  // Both are the same sanity LLM stage, just renumbered in the new flow.
  const stage = findStage(stages, 'stage-3/sanity') ?? findStage(stages, 'stage-5/sanity');
  if (!stage && !trace.sanity) return null;
  const sanity = trace.sanity;
  const sanityOutput = sanity
    ? {
        verdict: sanity.verdict,
        rationale: sanity.rationale,
        ...(sanity.degraded ? { degraded: true } : {}),
        ...(sanity.attempts !== undefined ? { attempts: sanity.attempts } : {}),
        ...(sanity.retried_reasons && sanity.retried_reasons.length > 0
          ? { retried_reasons: sanity.retried_reasons }
          : {}),
      }
    : {};
  return {
    stage: 'sanity',
    started_at: stage?.started_at ?? new Date().toISOString(),
    duration_ms: stage?.duration_ms ?? sanity?.latency_ms ?? 0,
    outcome: mapOutcome(stage),
    actions: [
      {
        action: 'sanity_check',
        duration_ms: stage?.duration_ms ?? sanity?.latency_ms ?? 0,
        outcome: mapOutcome(stage),
        llm_used: true,
        output: sanityOutput,
      },
    ],
    output: sanityOutput,
  };
}

/** Crude LLM-call counter — every action with `llm_used=true` (or steps with a `model`) increments. */
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

function inferReconciliationLabel(
  trace: PipelineTrace,
): DispatchV1Summary['reconciliation'] {
  if (!trace.verdict) return null;
  if (trace.verdict.decision === 'escalate') return 'escalated';
  const src = trace.verdict.source;
  if (src === 'description_classifier' || src === 'code_resolver' || src === 'reconciled') return src;
  return null;
}

/** Build the anchored summary from typed stage outputs. */
function buildAnchoredSummary(
  trace: PipelineTrace,
  parseDetail: { merchant_code_state?: string } | undefined,
  result: PipelineResult,
): DispatchV1Summary {
  const identify = trace.anchored_identify;
  const constrain = trace.anchored_constrain;
  const pick = trace.anchored_pick;
  return {
    merchant_code_state: (parseDetail?.merchant_code_state as never) ?? null,
    pipeline_architecture: 'anchored',
    // Legacy fields null under anchored.
    description_classifier_top_fit: null,
    code_resolver_code: null,
    reconciliation: null,
    operator_override_applied: constrain?.trace.override_matched ?? false,
    // Anchored fields.
    identify_kind: identify?.kind ?? null,
    scope_kind: constrain?.scope.kind ?? null,
    pick_fit: pick?.kind === 'accepted' ? pick.fit : null,
    pick_escalate_reason: pick?.kind === 'escalate' ? pick.reason : null,
    // Shared.
    final_code: result.final_code,
    sanity_verdict: trace.sanity?.verdict ?? result.sanity_verdict ?? null,
  };
}

/** Build the legacy summary from track-A/B/verdict outputs. */
function buildLegacySummary(
  trace: PipelineTrace,
  parseDetail: { merchant_code_state?: string } | undefined,
  result: PipelineResult,
): DispatchV1Summary {
  const reconciliationLabel = inferReconciliationLabel(trace);
  const topFit =
    trace.track_a?.annotated_candidates.find((c) => c.fit === 'fits')?.code ?? null;
  return {
    merchant_code_state: (parseDetail?.merchant_code_state as never) ?? null,
    pipeline_architecture: 'legacy',
    description_classifier_top_fit: topFit,
    code_resolver_code: trace.track_b?.resolved_code ?? null,
    reconciliation: reconciliationLabel,
    operator_override_applied: trace.track_b?.override_applied ?? false,
    // Anchored fields null under legacy.
    identify_kind: null,
    scope_kind: null,
    pick_fit: null,
    pick_escalate_reason: null,
    // Shared.
    final_code: result.final_code,
    sanity_verdict: trace.sanity?.verdict ?? result.sanity_verdict ?? null,
  };
}

export function assembleDispatchV1(params: AssembleParams): DispatchV1Response {
  const { itemId, operatorSlug, result, startedAt, completedAt } = params;
  const trace = result.trace;
  const architecture = trace.pipeline_architecture;
  const stages: DispatchV1Stage[] = [];

  stages.push(buildNormalizeStage(trace.stages));
  // Branch on architecture. Each variant emits the same DispatchV1Stage
  // wire shape; only the actions inside `classify` differ. Sanity is
  // shared (both architectures emit a sanity LLM call with the same
  // contract).
  stages.push(
    architecture === 'anchored'
      ? buildClassifyStageAnchored(trace.stages, trace, result)
      : buildClassifyStageLegacy(trace.stages, trace, result),
  );
  const sanity = buildSanityStage(trace.stages, trace);
  if (sanity) stages.push(sanity);

  const status: DispatchV1Response['status'] =
    result.final_code !== null
      ? 'succeeded'
      : result.sanity_verdict === 'BLOCK'
        ? 'rejected'
        : 'failed';

  const parseDetail = trace.stages.find((s) => s.name === 'stage-0a/parse')?.detail as
    | { merchant_code_state?: string }
    | undefined;

  const summary: DispatchV1Summary =
    architecture === 'anchored'
      ? buildAnchoredSummary(trace, parseDetail, result)
      : buildLegacySummary(trace, parseDetail, result);

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
    sanity_verdict: result.sanity_verdict,
    trace: v1Trace,
  };
}

// ---------------------------------------------------------------------------
// Canonical wire shape (shared by /batches/{id}/items and /classifications/dispatch)
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
 * Pull a retrieval_query string out of a PipelineTrace, regardless of
 * architecture. Under legacy this is track_a.effective_description;
 * under anchored we surface identify.canonical (the tariff-English
 * form pick fed into retrieval), which is the closest analog.
 */
export function retrievalQueryFromTrace(trace: PipelineTrace): string | null {
  if (trace.pipeline_architecture === 'anchored') {
    const id = trace.anchored_identify;
    return id?.kind === 'clean_product' ? id.canonical : null;
  }
  return trace.track_a?.effective_description ?? null;
}

/**
 * Derive ClassificationStatus from a PipelineTrace, regardless of
 * architecture.
 *
 * Legacy: read verdict.classification_status (the reconciliation output).
 * Anchored: derive from identify + pick semantics:
 *   - pick.kind='accepted' AND identify.kind='clean_product'  → AGREEMENT
 *     (the identify family + scope + picker all align on a code)
 *   - pick.kind='escalate'                                    → ZERO_SIGNAL
 *     (no code accepted — pipeline gave up)
 *   - any other combination                                   → DRIFT
 *     (the identify/constrain/pick chain produced a result but
 *      under non-ideal conditions; e.g. partial fit, family-scope
 *      with weak signal, etc.)
 */
export function classificationStatusFromTrace(trace: PipelineTrace): ClassificationStatus | null {
  if (trace.pipeline_architecture === 'anchored') {
    const pick = trace.anchored_pick;
    const identify = trace.anchored_identify;
    if (!pick) return null;
    if (pick.kind === 'escalate') return 'ZERO_SIGNAL';
    if (identify?.kind === 'clean_product' && pick.fit === 'fits') return 'AGREEMENT';
    return 'DRIFT';
  }
  return trace.verdict?.classification_status ?? null;
}

/**
 * Pull a confidence score out of a PipelineTrace, regardless of
 * architecture. Under legacy this is track_a.picker_confidence; under
 * anchored it's pick.confidence when pick accepted, null on escalate.
 */
export function classificationConfidenceFromTrace(trace: PipelineTrace): number | null {
  if (trace.pipeline_architecture === 'anchored') {
    const pick = trace.anchored_pick;
    return pick?.kind === 'accepted' ? pick.confidence : null;
  }
  return trace.track_a?.picker_confidence ?? null;
}
