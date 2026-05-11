/**
 * Stage 2 — Reconciliation.
 *
 * Architecture:
 *   1. classifyConflict() (deterministic, no LLM) categorizes the (Track A,
 *      Track B) state into one of six internal conflict types.
 *   2. Per-conflict handler emits the verdict.
 *   3. The verdict carries `classification_status` (V1 external surface,
 *      3 values: AGREEMENT | DRIFT | ZERO_SIGNAL) plus the legacy
 *      `conflict_type` field for forensic queries.
 *
 * The LLM is called only for DRIFT (heading agrees, leaf disputes), where
 * picking between competing leaves under a shared heading benefits from
 * arbitration. Every other conflict type is purely deterministic at this
 * point — even AMBIGUOUS accepts the resolver code at LOW confidence
 * rather than calling the LLM, since the description-side signal is by
 * definition non-corroborating.
 *
 * V1 surface collapse (internal conflict_type -> external classification_status):
 *   AGREEMENT          -> AGREEMENT  (accept, HIGH confidence, source=B or A)
 *   DRIFT              -> DRIFT      (accept, MEDIUM, LLM-arbitrated leaf)
 *   AMBIGUOUS          -> DRIFT      (accept, LOW, resolver carries the row)
 *   CONTRADICTION      -> DRIFT      (accept, MEDIUM, Track A rank-1 wins)
 *   ZERO_SIGNAL        -> ZERO_SIGNAL (escalate to HITL)
 *
 * audit_flag was removed in V1 (no post-clearance audit). The internal
 * conflict_type field still distinguishes the cases for forensic queries
 * via trace JSONB.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../../../inference/llm/structured-call.js';
import { env } from '../../../config/env.js';
import { classifyConflict } from './conflict-type.js';
import type {
  TrackAResult,
  TrackBResult,
  StageVerdictOutput,
  VerdictResult,
  ReconciliationSource,
  AnnotatedCandidate,
  ConfidenceBand,
} from '../shared/pipeline.types.js';

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

/**
 * Calls the reconciliation LLM for DRIFT conflicts. Both tracks agree at
 * the heading level but disagree on the leaf — the LLM picks among the
 * heading's candidates with full visibility into both sides.
 *
 * On LLM failure we fall back to the override-curated path when applicable
 * (single_b + override_applied → low confidence passthrough), preserving
 * the PR 1 graceful-degrade behavior.
 */
async function callReconciliationLlmForDrift(params: {
  cleaned_description: string;
  trackA: TrackAResult;
  trackB: TrackBResult;
}): Promise<VerdictResult | { kind: 'escalate'; reason: string }> {
  const { cleaned_description, trackA, trackB } = params;
  const model = env().LLM_MODEL_STRONG;

  const user = JSON.stringify({
    cleaned_description,
    conflict_type: 'DRIFT',
    annotated_candidates: trackA.annotated_candidates.map((c) => ({
      code: c.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      rrf_score: c.rrf_score,
      fit: c.fit,
      rationale: c.rationale,
    })),
    code_resolver: {
      resolved_code: trackB.resolved_code,
      resolution: trackB.resolution,
      override_applied: trackB.override_applied,
    },
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
    // LLM failure during DRIFT. If the resolver is override-curated, prefer
    // that — operator has explicitly endorsed the mapping. Otherwise fall
    // through to the resolver code at low confidence (still better than
    // escalating since both tracks landed on the same heading).
    if (trackB.resolved_code) {
      return {
        decision: 'accept',
        final_code: trackB.resolved_code,
        confidence_band: 'low' as ConfidenceBand,
        rationale: `DRIFT: reconciliation LLM unavailable (${outcome.kind}); accepting code_resolver code at low confidence`,
        source: 'code_resolver',
        classification_status: 'DRIFT',
        conflict_type: 'DRIFT',
      };
    }
    return { kind: 'escalate', reason: `DRIFT reconciliation LLM unavailable: ${outcome.kind}` };
  }

  const d = outcome.data;
  const decision = d.decision ?? 'escalate';

  if (decision === 'accept' && typeof d.final_code === 'string') {
    const allowedCodes = new Set<string>([
      ...trackA.annotated_candidates.map((c) => c.code),
      ...(trackB.resolved_code ? [trackB.resolved_code] : []),
    ]);
    if (!allowedCodes.has(d.final_code)) {
      return {
        kind: 'escalate',
        reason: `DRIFT LLM returned final_code='${d.final_code}' which is not in the allowed set`,
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
      confidence_band: 'medium' as ConfidenceBand,
      rationale: typeof d.rationale === 'string' ? d.rationale : 'DRIFT: LLM picked among heading candidates',
      source,
      classification_status: 'DRIFT',
      conflict_type: 'DRIFT',
    };
  }

  return {
    kind: 'escalate',
    reason:
      typeof d.disagreement_summary === 'string'
        ? `DRIFT LLM escalated: ${d.disagreement_summary}`
        : 'DRIFT LLM chose to escalate without summary',
  };
}

/* ------------------------------------------------------------------ */
/*  Per-conflict handlers                                              */
/* ------------------------------------------------------------------ */

function handleAgreement(trackA: TrackAResult, trackB: TrackBResult): VerdictResult {
  // Resolver code in Track A's fits set, OR single_a top is fits.
  if (trackB.resolved_code) {
    const resolverVerdict = trackA.annotated_candidates.find((c) => c.code === trackB.resolved_code);
    if (resolverVerdict?.fit === 'fits') {
      return {
        decision: 'accept',
        final_code: trackB.resolved_code,
        confidence_band: 'high',
        rationale: `AGREEMENT: code_resolver code is in description_classifier fits set — ${resolverVerdict.rationale}`,
        source: 'code_resolver',
        classification_status: 'AGREEMENT',
        conflict_type: 'AGREEMENT',
      };
    }
  }
  const top = topFitCandidate(trackA.annotated_candidates);
  if (top?.fit === 'fits') {
    return {
      decision: 'accept',
      final_code: top.code,
      confidence_band: 'high',
      rationale: `AGREEMENT: description_classifier produced a clear fit (single track) — ${top.rationale}`,
      source: 'description_classifier',
      classification_status: 'AGREEMENT',
      conflict_type: 'AGREEMENT',
    };
  }
  // Defensive: classifier should not return AGREEMENT without a candidate.
  // If we get here, something upstream is inconsistent — fall back to
  // escalation rather than a silent wrong answer.
  throw new Error(
    'reconciliation: AGREEMENT classified but no fits candidate found — upstream inconsistency',
  );
}

function handleContradiction(trackA: TrackAResult, trackB: TrackBResult): VerdictResult {
  // Description disagrees with merchant heading. Track A rank-1 wins; merchant code overridden.
  // Two sources can produce the rank-1: trackA.annotated_candidates (top fits/partial),
  // or trackB.subtree_candidates[0] when consistency_verdict='contradicts' (the unanchored top
  // forced through PR 5).
  const top = topFitCandidate(trackA.annotated_candidates);
  if (top) {
    return {
      decision: 'accept',
      final_code: top.code,
      confidence_band: 'medium',
      rationale: `CONTRADICTION: description pulls to a different chapter than merchant code — Track A rank-1 wins (${top.rationale})`,
      source: 'description_classifier',
      classification_status: 'DRIFT',
      conflict_type: 'CONTRADICTION',
    };
  }
  // Fall back to the forced subtree candidate from PR 5 (trackB.subtree_candidates[0]
  // is set to the unanchored top when consistency_verdict='contradicts').
  const subtreeTop = trackB.subtree_candidates[0];
  if (subtreeTop) {
    return {
      decision: 'accept',
      final_code: subtreeTop.code,
      confidence_band: 'medium',
      rationale: `CONTRADICTION: description-side unanchored top-1 (${subtreeTop.rationale})`,
      source: 'description_classifier',
      classification_status: 'DRIFT',
      conflict_type: 'CONTRADICTION',
    };
  }
  // Defensive: classifier should not return CONTRADICTION without any rank-1 source.
  throw new Error(
    'reconciliation: CONTRADICTION classified but no description-side candidate available',
  );
}

/**
 * AMBIGUOUS handler — replaces the legacy AMBIGUOUS_MATERIAL +
 * SPARSE_DESCRIPTION handlers (both had identical behavior; merchant code
 * wins at LOW confidence).
 *
 * The rationale string still distinguishes the two sub-cases so the trace
 * remains readable to humans debugging a row:
 *   - threshold_failed / no_fit  → "description too thin"
 *   - otherwise                  → "description silent on heading-constrained
 *                                   dimensions"
 */
function handleAmbiguous(trackA: TrackAResult, trackB: TrackBResult): VerdictResult {
  if (!trackB.resolved_code) {
    throw new Error('reconciliation: AMBIGUOUS classified but trackB has no resolved_code');
  }
  const trackASilent = trackA.threshold_failed || trackA.no_fit;
  const rationale = trackASilent
    ? 'AMBIGUOUS: description too thin for description_classifier to contribute; accepting merchant code at low confidence'
    : 'AMBIGUOUS: description silent on dimensions the heading constrains; accepting merchant code at low confidence';
  return {
    decision: 'accept',
    final_code: trackB.resolved_code,
    confidence_band: 'low',
    rationale,
    source: 'code_resolver',
    classification_status: 'DRIFT',
    conflict_type: 'AMBIGUOUS',
  };
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

export async function runReconciliation(
  trackA: TrackAResult,
  trackB: TrackBResult,
  cleaned_description: string,
): Promise<StageVerdictOutput> {
  const conflictType = classifyConflict(trackA, trackB);

  switch (conflictType) {
    case 'ZERO_SIGNAL':
      return {
        decision: 'escalate',
        disagreement_summary: 'ZERO_SIGNAL: both tracks returned no defensible candidate',
        classification_status: 'ZERO_SIGNAL',
        conflict_type: 'ZERO_SIGNAL',
      };

    case 'AGREEMENT':
      return handleAgreement(trackA, trackB);

    case 'CONTRADICTION':
      return handleContradiction(trackA, trackB);

    case 'AMBIGUOUS':
      return handleAmbiguous(trackA, trackB);

    // Legacy conflict types — kept in switch ONLY to satisfy exhaustive
    // type checking against the deprecated literals still present in
    // the ConflictType union for historical trace JSON. The classifier
    // never emits these; they route through the same handler.
    case 'AMBIGUOUS_MATERIAL':
    case 'SPARSE_DESCRIPTION':
      return handleAmbiguous(trackA, trackB);

    case 'DRIFT': {
      const result = await callReconciliationLlmForDrift({ cleaned_description, trackA, trackB });
      if ('kind' in result) {
        // LLM escalated the DRIFT case (returned an unallowed code or chose
        // to escalate). Per the canonical outcome map, this is the only
        // path other than ZERO_SIGNAL that can escalate.
        return {
          decision: 'escalate',
          disagreement_summary: result.reason,
          // ZERO_SIGNAL is the only legal escalate conflict_type. DRIFT
          // escalations are operationally a degenerate DRIFT — surface as
          // ZERO_SIGNAL so the HITL queue handles it uniformly.
          classification_status: 'ZERO_SIGNAL',
          conflict_type: 'ZERO_SIGNAL',
        };
      }
      return result;
    }
  }
}
