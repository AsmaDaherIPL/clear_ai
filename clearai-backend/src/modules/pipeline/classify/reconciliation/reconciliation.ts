/**
 * Stage 2 — Reconciliation.
 *
 * Architecture:
 *   1. classifyConflict() (deterministic, no LLM) categorizes the (Track A,
 *      Track B) state into one of five internal conflict types.
 *   2. Per-conflict handler emits the verdict.
 *   3. The verdict carries `classification_status` (V1 external surface,
 *      3 values: AGREEMENT | DRIFT | ZERO_SIGNAL) plus the internal
 *      `conflict_type` field for forensic trace queries.
 *
 * The LLM is called only for DRIFT (heading agrees, leaf disputes), where
 * picking between competing leaves under a shared heading benefits from
 * arbitration. Every other conflict type is purely deterministic — even
 * AMBIGUOUS accepts the resolver code rather than calling the LLM, since
 * the description-side signal is by definition non-corroborating.
 *
 * V1 surface collapse (internal conflict_type -> external classification_status):
 *   AGREEMENT          -> AGREEMENT  (accept, source=B or A)
 *   DRIFT              -> DRIFT      (accept, LLM-arbitrated leaf)
 *   AMBIGUOUS          -> DRIFT      (accept, resolver carries the row)
 *   CONTRADICTION      -> DRIFT      (accept, Track A rank-1 wins)
 *   ZERO_SIGNAL        -> ZERO_SIGNAL (escalate to HITL)
 */
import { z } from 'zod';
import { structuredLlmCall } from '../../../../inference/llm/structured-call.js';
import { getLlmStagePolicy } from '../../../../inference/llm/policy.js';
import { env } from '../../../../config/env.js';
import { classifyConflict } from './conflict-type.js';
import type {
  DescriptionClassifierResult,
  CodeResolverResult,
  StageVerdictOutput,
  VerdictResult,
  ReconciliationSource,
  AnnotatedCandidate,
} from '../../shared/pipeline.types.js';

function topFitCandidate(candidates: AnnotatedCandidate[]): AnnotatedCandidate | null {
  return (
    candidates.find((c) => c.fit === 'fits') ??
    // partial_family is the PR4 name; partial is the legacy alias kept
    // for compatibility with stored traces.
    candidates.find((c) => c.fit === 'partial_family' || c.fit === 'partial') ??
    null
  );
}

/** Top `chapter_adjacent` candidate from Track A, or null. */
function topChapterAdjacentCandidate(candidates: AnnotatedCandidate[]): AnnotatedCandidate | null {
  return candidates.find((c) => c.fit === 'chapter_adjacent') ?? null;
}

/** First two digits of an HS code; the chapter level. */
function chapterOf(code: string | null | undefined): string | null {
  if (!code || code.length < 2) return null;
  return code.slice(0, 2);
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
  trackA: DescriptionClassifierResult;
  trackB: CodeResolverResult;
}): Promise<
  | (VerdictResult & { attempts: number; retried_reasons: string[] })
  | { kind: 'escalate'; reason: string; attempts: number; retried_reasons: string[] }
> {
  const { cleaned_description, trackA, trackB } = params;
  const model = env().LLM_MODEL_STRONG;
  const policy = getLlmStagePolicy('reconciliation');

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
    timeoutMs: policy.timeoutMs,
    parseRetryPolicy: {
      enabled: policy.retryOnParseFailure,
      maxAttempts: policy.maxAttempts,
      totalBudgetMs: policy.totalBudgetMs,
    },
  });

  const attempts = outcome.trace.attempts;
  const retried_reasons = outcome.trace.retried_reasons ?? [];

  if (outcome.kind !== 'ok') {
    // LLM failure during DRIFT. If the resolver is override-curated, prefer
    // that — operator has explicitly endorsed the mapping. Otherwise fall
    // through to the resolver code at low confidence (still better than
    // escalating since both tracks landed on the same heading).
    if (trackB.resolved_code) {
      return {
        decision: 'accept',
        final_code: trackB.resolved_code,
        rationale: `DRIFT: reconciliation LLM unavailable (${outcome.kind}); accepting code_resolver code`,
        source: 'code_resolver',
        classification_status: 'DRIFT',
        conflict_type: 'DRIFT',
        attempts,
        retried_reasons,
      };
    }
    return {
      kind: 'escalate',
      reason: `DRIFT reconciliation LLM unavailable: ${outcome.kind}`,
      attempts,
      retried_reasons,
    };
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
        attempts,
        retried_reasons,
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
      rationale: typeof d.rationale === 'string' ? d.rationale : 'DRIFT: LLM picked among heading candidates',
      source,
      classification_status: 'DRIFT',
      conflict_type: 'DRIFT',
      attempts,
      retried_reasons,
    };
  }

  return {
    kind: 'escalate',
    reason:
      typeof d.disagreement_summary === 'string'
        ? `DRIFT LLM escalated: ${d.disagreement_summary}`
        : 'DRIFT LLM chose to escalate without summary',
    attempts,
    retried_reasons,
  };
}

/* ------------------------------------------------------------------ */
/*  Per-conflict handlers                                              */
/* ------------------------------------------------------------------ */

function handleAgreement(trackA: DescriptionClassifierResult, trackB: CodeResolverResult): VerdictResult {
  // Path 1: resolver code is in Track A's fits set — strongest signal,
  // both tracks endorse the same leaf.
  if (trackB.resolved_code) {
    const resolverVerdict = trackA.annotated_candidates.find((c) => c.code === trackB.resolved_code);
    if (resolverVerdict?.fit === 'fits') {
      return {
        decision: 'accept',
        final_code: trackB.resolved_code,
        rationale: `AGREEMENT: code_resolver code is in description_classifier fits set — ${resolverVerdict.rationale}`,
        source: 'code_resolver',
        classification_status: 'AGREEMENT',
        conflict_type: 'AGREEMENT',
      };
    }
  }
  // Path 1b (PR4 / Layer 2): chapter-family AGREEMENT. Track A marked a
  // candidate `chapter_adjacent` and the conflict-type classifier routed
  // here because Track B's resolved code sits in a different chapter that
  // the picker considered family-adjacent. The picker is saying "I see
  // the same product family across an HS chapter split" — Track B's
  // chapter-correct code wins.
  if (trackB.resolved_code) {
    const adjacent = topChapterAdjacentCandidate(trackA.annotated_candidates);
    if (adjacent && chapterOf(adjacent.code) !== chapterOf(trackB.resolved_code)) {
      return {
        decision: 'accept',
        final_code: trackB.resolved_code,
        rationale:
          `AGREEMENT (chapter-family): Track A marked ${adjacent.code} as chapter_adjacent to ${trackB.resolved_code} — same family, different HS chapters. ${adjacent.rationale}`,
        source: 'code_resolver',
        classification_status: 'AGREEMENT',
        conflict_type: 'AGREEMENT',
      };
    }
  }
  // Path 2: single_a path. Track A has positive signal but no resolver to
  // corroborate (or the resolver isn't in the fits set). Take Track A's
  // top positive candidate — `fits` preferred, but `partial` is accepted
  // when that's all Track A produced. This handles the "merchant supplied
  // no code, picker only labels partial" case (e.g. generic 'Jackets'
  // input where the picker labels every candidate partial because every
  // leaf constrains gender/material — none of which the description
  // confirms). With no resolver, AMBIGUOUS has no fallback, so AGREEMENT
  // on the top candidate is the right call.
  const top = topFitCandidate(trackA.annotated_candidates);
  if (top) {
    const note = top.fit === 'fits' ? 'a clear fit' : 'a partial fit (no resolver to corroborate)';
    return {
      decision: 'accept',
      final_code: top.code,
      rationale: `AGREEMENT: description_classifier produced ${note} (single track) — ${top.rationale}`,
      source: 'description_classifier',
      classification_status: 'AGREEMENT',
      conflict_type: 'AGREEMENT',
    };
  }
  // Defensive: classifier should not return AGREEMENT without a candidate.
  // If we get here, something upstream is inconsistent — throw rather than
  // ship a silent wrong answer.
  throw new Error(
    'reconciliation: AGREEMENT classified but no positive candidate found — upstream inconsistency',
  );
}

function handleContradiction(trackA: DescriptionClassifierResult, trackB: CodeResolverResult): VerdictResult {
  // Description disagrees with merchant heading. Track A rank-1 wins; merchant code overridden.
  // Two sources can produce the rank-1: trackA.annotated_candidates (top fits/partial),
  // or trackB.subtree_candidates[0] when consistency_verdict='contradicts' (the unanchored top
  // forced through PR 5).
  const top = topFitCandidate(trackA.annotated_candidates);
  if (top) {
    return {
      decision: 'accept',
      final_code: top.code,
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
 * AMBIGUOUS handler — merchant code wins because the description-side
 * signal is by definition non-corroborating. The rationale string
 * distinguishes the sub-cases (Track A silent vs. partial-converging)
 * so trace readers can still debug.
 */
function handleAmbiguous(trackA: DescriptionClassifierResult, trackB: CodeResolverResult): VerdictResult {
  if (!trackB.resolved_code) {
    throw new Error('reconciliation: AMBIGUOUS classified but trackB has no resolved_code');
  }

  // Detect convergence: Track A's top partial-family candidate is the
  // same code as Track B's resolved leaf. Only partial-family matters
  // here — a `fits` at the same code would have routed to AGREEMENT in
  // the classifier, not here. `does_not_fit` and `chapter_adjacent`
  // can't represent convergence at this leaf (chapter_adjacent is by
  // definition a different chapter, not the same leaf).
  const topPartial = trackA.annotated_candidates.find(
    (c) => c.fit === 'partial_family' || c.fit === 'partial',
  );
  const converges = topPartial != null && topPartial.code === trackB.resolved_code;

  const trackASilent = trackA.threshold_failed || trackA.no_fit;
  const rationale = converges
    ? `AMBIGUOUS (converging): Track A partial and code_resolver agree on ${trackB.resolved_code}; description silent on one leaf-specialization dimension.`
    : trackASilent
      ? 'AMBIGUOUS: description too thin for description_classifier to contribute; accepting merchant code'
      : 'AMBIGUOUS: description silent on dimensions the heading constrains; accepting merchant code';

  return {
    decision: 'accept',
    final_code: trackB.resolved_code,
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
  trackA: DescriptionClassifierResult,
  trackB: CodeResolverResult,
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
