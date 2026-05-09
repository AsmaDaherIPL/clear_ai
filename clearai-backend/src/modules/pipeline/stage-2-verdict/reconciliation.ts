import { z } from 'zod';
import { structuredLlmCall } from '../../../inference/llm/structured-call.js';
import { env } from '../../../config/env.js';
import type {
  TrackAResult,
  TrackBResult,
  StageVerdictOutput,
  SignalCount,
  ReconciliationSource,
  AnnotatedCandidate,
} from '../shared/pipeline.types.js';

function countSignals(trackA: TrackAResult, trackB: TrackBResult): SignalCount {
  const hasA = trackA.annotated_candidates.some((c) => c.fit === 'fits' || c.fit === 'partial');
  const hasB = !!trackB.resolved_code;
  if (hasA && hasB) return 'two_signal';
  if (hasA) return 'single_a';
  if (hasB) return 'single_b';
  return 'zero';
}

function topFitCandidate(candidates: AnnotatedCandidate[]): AnnotatedCandidate | null {
  return (
    candidates.find((c) => c.fit === 'fits') ??
    candidates.find((c) => c.fit === 'partial') ??
    null
  );
}

const ReconciliationSchema = z
  .object({
    decision: z.enum(['accept', 'escalate']).optional(),
    final_code: z.unknown().optional(),
    source: z.enum(['description_classifier', 'code_resolver', 'reconciled']).optional(),
    rationale: z.unknown().optional(),
    disagreement_summary: z.unknown().optional(),
  })
  .passthrough();

async function callReconciliationLlm(params: {
  cleaned_description: string;
  annotated_candidates: AnnotatedCandidate[];
  trackB: TrackBResult;
  signal_count: SignalCount;
}): Promise<StageVerdictOutput> {
  const model = env().LLM_MODEL_STRONG;

  const user = JSON.stringify({
    cleaned_description: params.cleaned_description,
    signal_count: params.signal_count,
    annotated_candidates: params.annotated_candidates.map((c) => ({
      code: c.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      rrf_score: c.rrf_score,
      fit: c.fit,
      rationale: c.rationale,
    })),
    code_resolver: params.trackB.resolved_code
      ? {
          resolved_code: params.trackB.resolved_code,
          resolution: params.trackB.resolution,
          override_applied: params.trackB.override_applied,
        }
      : null,
  });

  const outcome = await structuredLlmCall({
    promptFile: 'reconciliation.md',
    user,
    schema: ReconciliationSchema,
    stage: 'reconciliation',
    model,
    maxTokens: 512,
    timeoutMs: 15_000,
  });

  if (outcome.kind !== 'ok') {
    // LLM failure in single_b: if track_b has override-curated code, pass it through
    // at reduced confidence rather than discard all signal.
    if (params.signal_count === 'single_b' && params.trackB.resolved_code && params.trackB.override_applied) {
      return {
        decision: 'accept',
        final_code: params.trackB.resolved_code,
        confidence: 0.5,
        rationale: `code_resolver passthrough (override-curated); reconciliation LLM unavailable: ${outcome.kind}`,
        source: 'code_resolver',
      };
    }
    return {
      decision: 'escalate',
      disagreement_summary: `reconciliation LLM failed: ${outcome.kind}`,
    };
  }

  const d = outcome.data;
  const decision = d.decision ?? 'escalate';

  if (decision === 'accept' && typeof d.final_code === 'string') {
    // Validate: code must come from the allowed set (annotated candidates or code_resolver).
    const allowedCodes = new Set<string>([
      ...params.annotated_candidates.map((c) => c.code),
      ...(params.trackB.resolved_code ? [params.trackB.resolved_code] : []),
    ]);

    if (!allowedCodes.has(d.final_code)) {
      return {
        decision: 'escalate',
        disagreement_summary: `reconciliation LLM returned final_code='${d.final_code}' which is not in the allowed set; escalating.`,
      };
    }

    const source: ReconciliationSource =
      typeof d.source === 'string' &&
      ['description_classifier', 'code_resolver', 'reconciled'].includes(d.source)
        ? (d.source as ReconciliationSource)
        : 'reconciled';

    return {
      decision: 'accept',
      final_code: d.final_code,
      confidence: 0.75,
      rationale: typeof d.rationale === 'string' ? d.rationale : '',
      source,
    };
  }

  return {
    decision: 'escalate',
    disagreement_summary:
      typeof d.disagreement_summary === 'string'
        ? d.disagreement_summary
        : 'LLM chose to escalate without summary',
  };
}

export async function runReconciliation(
  trackA: TrackAResult,
  trackB: TrackBResult,
  cleaned_description: string,
): Promise<StageVerdictOutput> {
  const signal_count = countSignals(trackA, trackB);

  if (signal_count === 'zero') {
    return { decision: 'escalate', disagreement_summary: 'both tracks returned no signal' };
  }

  // Deterministic shortcut: resolver code is in the fits set — independent corroboration.
  if (trackB.resolved_code) {
    const resolverVerdict = trackA.annotated_candidates.find((c) => c.code === trackB.resolved_code);
    if (resolverVerdict?.fit === 'fits') {
      return {
        decision: 'accept',
        final_code: trackB.resolved_code,
        confidence: 1.0,
        rationale: `code_resolver and description_classifier agree: ${resolverVerdict.rationale}`,
        source: 'code_resolver',
      };
    }
    if (resolverVerdict?.fit === 'partial') {
      return {
        decision: 'accept',
        final_code: trackB.resolved_code,
        confidence: 0.8,
        rationale: `code_resolver in partial-fit set: ${resolverVerdict.rationale}`,
        source: 'code_resolver',
      };
    }
  }

  // Deterministic shortcut: single_a with a fits candidate — no resolver to dispute it.
  if (signal_count === 'single_a') {
    const top = topFitCandidate(trackA.annotated_candidates);
    if (top) {
      return {
        decision: 'accept',
        final_code: top.code,
        confidence: top.fit === 'fits' ? 0.85 : 0.65,
        rationale: top.rationale,
        source: 'description_classifier',
      };
    }
    return { decision: 'escalate', disagreement_summary: 'description_classifier: no fits or partial candidates' };
  }

  // All other cases go to the LLM: two_signal disagreement, single_b verification.
  return callReconciliationLlm({
    cleaned_description,
    annotated_candidates: trackA.annotated_candidates,
    trackB,
    signal_count,
  });
}
