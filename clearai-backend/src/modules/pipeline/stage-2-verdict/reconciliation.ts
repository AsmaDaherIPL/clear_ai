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
      signal_count: params.signal_count,
      disagreement_summary: `reconciliation LLM failed: ${outcome.kind}`,
    };
  }

  const d = outcome.data;
  const decision = d.decision ?? 'escalate';

  if (decision === 'accept' && typeof d.chosen_code === 'string') {
    const source: ReconciliationSource =
      d.source === 'track_a' || d.source === 'track_b' || d.source === 'reconciled'
        ? d.source
        : 'reconciled';
    return {
      decision: 'accept',
      final_code: d.chosen_code,
      confidence: typeof d.confidence === 'number' ? d.confidence : 0.7,
      rationale: typeof d.rationale === 'string' ? d.rationale : '',
      source,
      signal_count: params.signal_count,
    };
  }

  return {
    decision: 'escalate',
    signal_count: params.signal_count,
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
        signal_count,
        disagreement_summary: 'both tracks returned no signal',
      };

    case 'single_a':
      return {
        decision: 'accept',
        final_code: trackA.chosen_code!,
        confidence: trackA.confidence ?? 0.7,
        rationale: trackA.rationale ?? 'single signal from Track A',
        source: 'track_a',
        signal_count,
      };

    case 'single_b':
      // Light-verify via LLM before accepting a code-only result.
      return callReconciliationLlm({
        track_a_code: null,
        track_a_rationale: null,
        track_b_code: trackB.resolved_code,
        track_b_resolution: trackB.resolution,
        cleaned_description,
        signal_count,
      });

    case 'two_signal': {
      const a = trackA.chosen_code!;
      const b = trackB.resolved_code!;

      if (codesAgree(a, b)) {
        // Deterministic agree — no LLM needed, prefer Track A (blind to merchant).
        return {
          decision: 'accept',
          final_code: a,
          confidence: 1.0,
          rationale: 'Track A and Track B agree',
          source: 'track_a',
          signal_count,
        };
      }

      // Disagree — let the LLM arbitrate.
      return callReconciliationLlm({
        track_a_code: a,
        track_a_rationale: trackA.rationale,
        track_b_code: b,
        track_b_resolution: trackB.resolution,
        cleaned_description,
        signal_count,
      });
    }
  }
}
