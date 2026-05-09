/**
 * Stage 2 — Verdict / Reconciliation (standard LLM, Sonnet-tier).
 *
 * Compares Track A and Track B outputs. Resolves the signal-count case
 * and, when needed, calls the LLM to arbitrate disagreements.
 *
 * Signal-count rules:
 *   two_signal + agree  → accept without LLM (prefix match or exact)
 *   two_signal + disagree → standard LLM reconciles
 *   single_a            → accept Track A
 *   single_b            → standard LLM light-verifies then accepts
 *   zero                → escalate to HITL
 */
import { z } from 'zod';
import { structuredLlmCall } from '../../../inference/llm/structured-call.js';
import { env } from '../../../config/env.js';
import type {
  TrackAResult,
  TrackBResult,
  StageVerdictOutput,
  SignalCount,
  ReconciliationSource,
} from '../shared/pipeline.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function codePrefix(code: string, len: number): string {
  return code.slice(0, len);
}

function codesAgree(a: string, b: string): boolean {
  // Exact match OR same HS-8 heading (first 8 digits).
  return a === b || codePrefix(a, 8) === codePrefix(b, 8);
}

function countSignals(trackA: TrackAResult, trackB: TrackBResult): SignalCount {
  const hasA = !!trackA.chosen_code;
  const hasB = !!trackB.resolved_code;
  if (hasA && hasB) return 'two_signal';
  if (hasA) return 'single_a';
  if (hasB) return 'single_b';
  return 'zero';
}

// ---------------------------------------------------------------------------
// LLM schema
// ---------------------------------------------------------------------------

const ReconciliationSchema = z
  .object({
    decision: z.enum(['accept', 'escalate']).optional(),
    chosen_code: z.unknown().optional(),
    confidence: z.unknown().optional(),
    rationale: z.unknown().optional(),
    source: z.enum(['track_a', 'track_b', 'reconciled']).optional(),
    disagreement_summary: z.unknown().optional(),
  })
  .passthrough();

async function callReconciliationLlm(params: {
  track_a_code: string | null;
  track_a_rationale: string | null;
  /** Top description-classifier candidates with EN/AR descriptions. Always
   *  passed (when retrieval returned anything) so the LLM has description
   *  evidence even when track A couldn't pick. */
  track_a_candidates: ReadonlyArray<{ code: string; description_en: string | null; description_ar: string | null }>;
  track_b_code: string | null;
  track_b_resolution: string;
  cleaned_description: string;
  signal_count: SignalCount;
}): Promise<StageVerdictOutput> {
  const model = env().LLM_MODEL_STRONG;

  const user = JSON.stringify({
    cleaned_description: params.cleaned_description,
    signal_count: params.signal_count,
    track_a: params.track_a_code
      ? { code: params.track_a_code, rationale: params.track_a_rationale }
      : null,
    // The retrieval candidate list is shown even when track_a.code is null
    // (threshold/no_fit). The LLM uses it to reason about whether track_b's
    // code is plausible for the description.
    track_a_candidates: params.track_a_candidates.slice(0, 8),
    track_b: params.track_b_code
      ? { code: params.track_b_code, resolution: params.track_b_resolution }
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
    // LLM failed — escalate rather than guess.
    return {
      decision: 'escalate',
      disagreement_summary: `reconciliation LLM failed: ${outcome.kind}`,
    };
  }

  const d = outcome.data;
  const decision = d.decision ?? 'escalate';

  if (decision === 'accept' && typeof d.chosen_code === 'string') {
    // The LLM's job is to PICK between the two opinions, not invent
    // a third. Reject anything that doesn't match track A or track B
    // exactly — a hallucinated code would 12-digit-look-real but fail
    // the FK to zatca_hs_codes downstream and ship as a ZATCA-rejected
    // declaration.
    const candidates = [params.track_a_code, params.track_b_code].filter(
      (c): c is string => typeof c === 'string' && /^\d{12}$/.test(c),
    );
    const matched = candidates.find((c) => c === d.chosen_code) ?? null;
    if (matched !== null) {
      const source: ReconciliationSource =
        matched === params.track_a_code ? 'track_a' : 'track_b';
      return {
        decision: 'accept',
        final_code: matched,
        confidence: typeof d.confidence === 'number' ? d.confidence : 0.7,
        rationale: typeof d.rationale === 'string' ? d.rationale : '',
        source,
      };
    }
    // LLM returned a code that doesn't match either track. Escalate
    // — the picker spec only authorises choosing between A and B.
    return {
      decision: 'escalate',
      disagreement_summary:
        `reconciliation LLM returned chosen_code='${d.chosen_code}' which matches neither ` +
        `track_a (${params.track_a_code ?? 'null'}) nor track_b (${params.track_b_code ?? 'null'}); escalating.`,
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

// ---------------------------------------------------------------------------
// Main reconciliation entry point
// ---------------------------------------------------------------------------

export async function runReconciliation(
  trackA: TrackAResult,
  trackB: TrackBResult,
  cleaned_description: string,
): Promise<StageVerdictOutput> {
  const signal_count = countSignals(trackA, trackB);

  switch (signal_count) {
    case 'zero':
      return {
        decision: 'escalate',
        disagreement_summary: 'both tracks returned no signal',
      };

    case 'single_a':
      return {
        decision: 'accept',
        final_code: trackA.chosen_code!,
        confidence: trackA.confidence ?? 0.7,
        rationale: trackA.rationale ?? 'single signal from description_classifier',
        source: 'track_a',
      };

    case 'single_b':
      // Light-verify via LLM, with the description-classifier candidate
      // list as evidence. If retrieval pulled candidates that disagree
      // with track_b's chapter, the LLM can escalate with that context;
      // if the candidates are coherent with track_b (or track_a returned
      // no candidates at all), the LLM accepts.
      return callReconciliationLlm({
        track_a_code: null,
        track_a_rationale: null,
        track_a_candidates: trackA.candidates,
        track_b_code: trackB.resolved_code,
        track_b_resolution: trackB.resolution,
        cleaned_description,
        signal_count,
      });

    case 'two_signal': {
      const a = trackA.chosen_code!;
      const b = trackB.resolved_code!;

      if (codesAgree(a, b)) {
        // Deterministic agree — no LLM needed, prefer description_classifier
        // (blind to merchant code).
        return {
          decision: 'accept',
          final_code: a,
          confidence: 1.0,
          rationale: 'description_classifier and code_resolver agree',
          source: 'track_a',
        };
      }

      // Disagree — let the LLM arbitrate.
      return callReconciliationLlm({
        track_a_code: a,
        track_a_rationale: trackA.rationale,
        track_a_candidates: trackA.candidates,
        track_b_code: b,
        track_b_resolution: trackB.resolution,
        cleaned_description,
        signal_count,
      });
    }
  }
}
