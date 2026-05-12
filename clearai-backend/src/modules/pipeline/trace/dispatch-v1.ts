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
 */
import type {
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

function buildClassifyStage(
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

function buildSanityStage(
  stages: StageTrace[],
  trace: PipelineTrace,
): DispatchV1Stage | null {
  const stage = findStage(stages, 'stage-3/sanity');
  if (!stage && !trace.sanity) return null;
  const sanity = trace.sanity;
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
        output: sanity
          ? { verdict: sanity.verdict, rationale: sanity.rationale }
          : {},
      },
    ],
    output: sanity
      ? { verdict: sanity.verdict, rationale: sanity.rationale }
      : {},
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

export function assembleDispatchV1(params: AssembleParams): DispatchV1Response {
  const { itemId, operatorSlug, result, startedAt, completedAt } = params;
  const trace = result.trace;
  const stages: DispatchV1Stage[] = [];

  stages.push(buildNormalizeStage(trace.stages));
  stages.push(buildClassifyStage(trace.stages, trace, result));
  const sanity = buildSanityStage(trace.stages, trace);
  if (sanity) stages.push(sanity);

  const status: DispatchV1Response['status'] =
    result.final_code !== null
      ? 'succeeded'
      : result.sanity_verdict === 'BLOCK'
        ? 'rejected'
        : 'failed';

  const reconciliationLabel = inferReconciliationLabel(trace);
  const parseDetail = trace.stages.find((s) => s.name === 'stage-0a/parse')?.detail as
    | { merchant_code_state?: string }
    | undefined;
  const topFit =
    trace.track_a?.annotated_candidates.find((c) => c.fit === 'fits')?.code ?? null;
  const summary: DispatchV1Summary = {
    merchant_code_state: (parseDetail?.merchant_code_state as never) ?? null,
    description_classifier_top_fit: topFit,
    code_resolver_code: trace.track_b?.resolved_code ?? null,
    reconciliation: reconciliationLabel,
    operator_override_applied: trace.track_b?.override_applied ?? false,
    final_code: result.final_code,
    sanity_verdict: trace.sanity?.verdict ?? result.sanity_verdict ?? null,
  };

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
