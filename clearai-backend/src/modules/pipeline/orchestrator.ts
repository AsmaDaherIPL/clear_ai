/**
 * Pipeline orchestrator — canonical single-pipeline implementation (PR 13).
 *
 * Wires the new flow end-to-end:
 *
 *   parse (deterministic)
 *      |
 *   parallel { identify_fast, merchant_resolution }
 *      |
 *   if identify_fast.kind === uninformative+genuine OR multi_product:
 *     identify_web (replaces identify_fast)
 *      |
 *   scope_selection (deterministic)
 *      |
 *   if scope.primary.kind === escalate: short-circuit
 *      |
 *   multi-arm retrieval + dedupe (parallel arms)
 *      |
 *   reranker (deterministic, top 8)
 *      |
 *   picker (Sonnet, single call)
 *      |
 *   if pick.kind === escalate: short-circuit
 *      |
 *   verifier (deterministic, PASS / UNCERTAIN)
 *      |
 *   parallel { submission_description, sanity_check }
 *      |
 *   build PipelineResult with HITL routing based on verify + sanity
 *
 * Promoted from v2/orchestrator.ts in PR 13. runPipelineV2 renamed to
 * runPipeline. No architecture branching — this is the only pipeline.
 */
import { parseItem } from './parse/parse.js';
import { runIdentifyFast } from './v2/identify/fast.js';
import { runIdentifyWeb } from './v2/identify/web.js';
import {
  resolveMerchant,
  buildResolutionTrace,
} from './merchant/resolve.js';
import { selectScopes } from './v2/scope/select.js';
import { runMultiArmRetrieval } from './v2/retrieve/multi-arm.js';
import { dedupeCandidates } from './v2/retrieve/union.js';
import { rerank } from './v2/retrieve/rerank.js';
import { runPick } from './v2/pick/pick.js';
import { verifyClassification } from './v2/pick/verify.js';
import { generateSubmissionDescription } from './submission-description/submission-description.js';
import { runSanity } from './sanity/sanity.js';
import { lookupCatalogContext } from './catalog/catalog-context.js';
import { loadOperatorPipelineConfig } from './catalog/operator-pipeline-config.js';
import type {
  CanonicalLineItem,
  ClassificationStatus,
  HitlIntent,
  IdentifyResult,
  PickResult,
  PipelineResult,
  PipelineTrace,
  SanityResult,
  ScopeSelection,
} from './types.js';

/**
 * Should the orchestrator follow up with identify_web?
 * Per Q2 (2026-05-15): only on genuine give-ups or multi_product. NOT
 * on low-confidence clean_product (confidence is uncalibrated).
 */
function shouldRunWebFallback(fastResult: IdentifyResult): boolean {
  if (fastResult.kind === 'uninformative' && fastResult.cause === 'genuine') return true;
  if (fastResult.kind === 'multi_product') return true;
  return false;
}

/**
 * Derive ClassificationStatus from pick + verify + identify.
 *
 *   pick escalate                          -> ZERO_SIGNAL
 *   pick accepted + verify UNCERTAIN       -> DRIFT
 *   pick accepted + verify PASS + clean_product + fits  -> AGREEMENT
 *   anything else (partial fit, etc.)      -> DRIFT
 */
function classificationStatusFor(
  pick: PickResult,
  identify: IdentifyResult,
  verify: { result: 'PASS' | 'UNCERTAIN' } | null,
): ClassificationStatus | null {
  if (pick.kind === 'escalate') return 'ZERO_SIGNAL';
  if (verify?.result === 'UNCERTAIN') return 'DRIFT';
  if (identify.kind === 'clean_product' && pick.fit === 'fits') return 'AGREEMENT';
  return 'DRIFT';
}

/**
 * HITL routing rules:
 *   sanity.verdict === 'FLAG'     -> 'sanity_flag'
 *   verify.result === 'UNCERTAIN' -> 'verifier_uncertain'
 *   pick.escalate (any reason)    -> 'verdict_escalate' or 'low_information'
 *   otherwise                     -> null (accept clean)
 */
function buildHitl(
  pick: PickResult,
  identify: IdentifyResult,
  verify: { result: 'PASS' | 'UNCERTAIN' } | null,
  sanity: SanityResult | null,
  rawDescription: string,
): HitlIntent | null {
  const cleaned =
    identify.kind === 'clean_product' ? identify.canonical : rawDescription;

  if (sanity?.verdict === 'FLAG') {
    return { reason: 'sanity_flag', cleaned_description: cleaned };
  }
  if (verify?.result === 'UNCERTAIN') {
    return { reason: 'verifier_uncertain', cleaned_description: cleaned };
  }
  if (pick.kind === 'escalate') {
    if (
      pick.reason === 'identify_no_query' &&
      identify.kind === 'uninformative' &&
      identify.cause === 'genuine'
    ) {
      return { reason: 'low_information', cleaned_description: cleaned };
    }
    return { reason: 'verdict_escalate', cleaned_description: cleaned };
  }
  return null;
}

/**
 * infra_degraded detection: an LLM stage exhausted retries or hit a
 * transport-class failure that's recoverable on retry.
 */
function detectInfraDegraded(params: {
  identify: IdentifyResult;
  pick: PickResult;
  submissionInvoked: 'llm' | 'llm_failed' | 'fallback' | 'fallback_after_collision' | null;
  sanityDegraded: boolean;
}): boolean {
  if (
    params.identify.kind === 'uninformative' &&
    params.identify.cause === 'transport'
  ) {
    return true;
  }
  if (
    params.pick.kind === 'escalate' &&
    params.pick.reason === 'picker_unavailable' &&
    (params.pick.trace.status === 'error' || params.pick.trace.status === 'timeout')
  ) {
    return true;
  }
  if (params.submissionInvoked === 'llm_failed') return true;
  if (params.sanityDegraded) return true;
  return false;
}

/**
 * Public entry. Runs the pipeline end-to-end and returns a PipelineResult.
 *
 * Never throws on stage-level failures — each stage returns a typed
 * union with escalate variants. Throws only on programmer error
 * (missing prompt file, schema invariant violation).
 */
export async function runPipeline(
  item: CanonicalLineItem,
  operatorSlug: string,
  _itemId: string,
): Promise<PipelineResult> {
  // ---- Stage 1: Parse ----
  const parsed = parseItem(item);
  if (parsed.rejected) {
    return blockedResult(parsed.reason);
  }
  const rawDescription = parsed.item.raw_description;
  if (rawDescription === null) {
    throw new Error(
      'orchestrator invariant: parse accepted but raw_description is null',
    );
  }

  // ---- Stages 2a + 3 in parallel: identify_fast + merchant_resolution ----
  const opConfig = await loadOperatorPipelineConfig(operatorSlug);
  const merchantStart = Date.now();
  const [identifyFast, merchantResolution] = await Promise.all([
    runIdentifyFast(rawDescription),
    resolveMerchant(
      parsed.item.raw_merchant_code,
      placeholderIdentify(),
      operatorSlug,
      opConfig.overridesEnabled,
    ),
  ]);

  // ---- Stage 2b conditional: identify_web fallback ----
  let identify: IdentifyResult = identifyFast;
  if (shouldRunWebFallback(identifyFast)) {
    identify = await runIdentifyWeb(rawDescription, identifyFast);
  }

  const merchantResolutionTrace = buildResolutionTrace(
    merchantResolution,
    merchantStart,
    false,
    opConfig.overridesEnabled,
  );

  // ---- Stage 4: Scope selection ----
  const scope = selectScopes(identify, merchantResolution);

  if (scope.primary.kind === 'escalate') {
    return buildEscalateResult({
      identify,
      merchantResolution,
      merchantResolutionTrace,
      scope,
      pick: {
        kind: 'escalate',
        reason: 'scope_escalate',
        detail: `scope escalated: ${scope.primary.reason}`,
        trace: {
          llm_called: false,
          latency_ms: 0,
          model: null,
          status: 'skipped',
          candidate_count: 0,
          audit_flag: false,
        },
      },
      rawDescription,
    });
  }

  // ---- Stage 5: Multi-arm retrieval ----
  const query =
    identify.kind === 'clean_product'
      ? `${identify.canonical}${identify.identity_tokens.length > 0 ? ' ' + identify.identity_tokens.join(' ') : ''}`.trim()
      : rawDescription;

  const retrieval = await runMultiArmRetrieval(scope, query);
  const dedupedCandidates = dedupeCandidates(retrieval.candidates);

  if (dedupedCandidates.length === 0) {
    return buildEscalateResult({
      identify,
      merchantResolution,
      merchantResolutionTrace,
      scope,
      pick: {
        kind: 'escalate',
        reason: 'no_candidates',
        detail: 'all arms returned 0 candidates after dedupe',
        trace: {
          llm_called: false,
          latency_ms: 0,
          model: null,
          status: 'skipped',
          candidate_count: 0,
          audit_flag: false,
        },
      },
      rawDescription,
      retrievalStats: {
        primary_candidate_count: retrieval.per_arm_counts[scope.primary.kind] ?? 0,
        secondary_candidate_counts: extractSecondaryCounts(scope, retrieval.per_arm_counts),
        candidates_before_rerank: 0,
        candidates_after_rerank: 0,
      },
    });
  }

  // ---- Stage 6: Reranker ----
  const reranked = rerank(dedupedCandidates, identify);

  // ---- Stage 7: Pick ----
  const merchantChapter = extractMerchantChapter(merchantResolution);
  const pick = await runPick({
    identify,
    candidates: reranked,
    merchant_chapter: merchantChapter,
  });

  if (pick.kind === 'escalate') {
    return buildEscalateResult({
      identify,
      merchantResolution,
      merchantResolutionTrace,
      scope,
      pick,
      rawDescription,
      retrievalStats: {
        primary_candidate_count: retrieval.per_arm_counts[scope.primary.kind] ?? 0,
        secondary_candidate_counts: extractSecondaryCounts(scope, retrieval.per_arm_counts),
        candidates_before_rerank: dedupedCandidates.length,
        candidates_after_rerank: reranked.length,
      },
    });
  }

  // ---- Stage 8: Verifier ----
  const verify = verifyClassification(pick, identify);

  // ---- Stages 9 + 10 in parallel: submission_description + sanity ----
  const catalog = await lookupCatalogContext(pick.final_code);
  const cleanedForSubmission =
    identify.kind === 'clean_product' ? identify.canonical : rawDescription;
  const [submission, sanity] = await Promise.all([
    generateSubmissionDescription({
      cleanedDescription: cleanedForSubmission,
      rawDescription,
      chosenCode: pick.final_code,
      catalogLeafAr: catalog.leafAr,
      catalogLeafEn: catalog.leafEn,
      catalogPathAr: catalog.pathAr,
      catalogPathEn: catalog.pathEn,
      identityTokens:
        identify.kind === 'clean_product' ? identify.identity_tokens : [],
    }),
    runSanity({
      final_code: pick.final_code,
      cleaned_description: cleanedForSubmission,
      raw_description: rawDescription,
      value_amount:
        typeof item.valueAmountSar === 'number' && Number.isFinite(item.valueAmountSar)
          ? item.valueAmountSar
          : parsed.item.value_amount,
      currency_code: 'SAR',
    }),
  ]);

  // ---- Final result assembly ----
  const trace: PipelineTrace = {
    identify,
    merchant_resolution: {
      resolution: merchantResolution,
      trace: merchantResolutionTrace,
    },
    scope,
    retrieval: {
      primary_candidate_count: retrieval.per_arm_counts[scope.primary.kind] ?? 0,
      secondary_candidate_counts: extractSecondaryCounts(scope, retrieval.per_arm_counts),
      candidates_before_rerank: dedupedCandidates.length,
      candidates_after_rerank: reranked.length,
    },
    pick,
    verify,
    sanity,
    stages: [],
  };

  return {
    final_code: pick.final_code,
    goods_description_ar: submission.descriptionAr,
    sanity_verdict: sanity.verdict,
    classification_status: classificationStatusFor(pick, identify, verify),
    hitl: buildHitl(pick, identify, verify, sanity, rawDescription),
    trace,
    infra_degraded: detectInfraDegraded({
      identify,
      pick,
      submissionInvoked: submission.invoked,
      sanityDegraded: sanity.degraded === true,
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blockedResult(reason: string): PipelineResult {
  return {
    final_code: null,
    goods_description_ar: null,
    sanity_verdict: 'BLOCK',
    classification_status: null,
    hitl: null,
    trace: {
      identify: {
        kind: 'uninformative',
        cause: 'short_circuit',
        reason: `parse rejected: ${reason}`,
        trace: {
          pass: 'fast',
          llm_called: false,
          latency_ms: 0,
          model: null,
          status: 'skipped',
          web_search_used: false,
          evidence_mismatch: false,
        },
      },
      merchant_resolution: {
        resolution: { state: 'absent' },
        trace: {
          llm_called: false,
          latency_ms: 0,
          override_attempted: false,
          override_matched: false,
        },
      },
      scope: {
        primary: { kind: 'escalate', reason: 'identify_uninformative_no_merchant' },
        secondaries: [],
        audit_flags: [],
      },
      retrieval: {
        primary_candidate_count: 0,
        secondary_candidate_counts: {},
        candidates_before_rerank: 0,
        candidates_after_rerank: 0,
      },
      pick: {
        kind: 'escalate',
        reason: 'scope_escalate',
        detail: `parse rejected: ${reason}`,
        trace: {
          llm_called: false,
          latency_ms: 0,
          model: null,
          status: 'skipped',
          candidate_count: 0,
          audit_flag: false,
        },
      },
      verify: null,
      sanity: null,
      stages: [],
    },
    infra_degraded: false,
  };
}

function buildEscalateResult(params: {
  identify: IdentifyResult;
  merchantResolution: PipelineTrace['merchant_resolution']['resolution'];
  merchantResolutionTrace: PipelineTrace['merchant_resolution']['trace'];
  scope: ScopeSelection;
  pick: PickResult;
  rawDescription: string;
  retrievalStats?: PipelineTrace['retrieval'];
}): PipelineResult {
  const {
    identify,
    merchantResolution,
    merchantResolutionTrace,
    scope,
    pick,
    rawDescription,
    retrievalStats,
  } = params;
  const trace: PipelineTrace = {
    identify,
    merchant_resolution: {
      resolution: merchantResolution,
      trace: merchantResolutionTrace,
    },
    scope,
    retrieval: retrievalStats ?? {
      primary_candidate_count: 0,
      secondary_candidate_counts: {},
      candidates_before_rerank: 0,
      candidates_after_rerank: 0,
    },
    pick,
    verify: null,
    sanity: null,
    stages: [],
  };
  return {
    final_code: null,
    goods_description_ar: null,
    sanity_verdict: 'PASS',
    classification_status: classificationStatusFor(pick, identify, null),
    hitl: buildHitl(pick, identify, null, null, rawDescription),
    trace,
    infra_degraded: detectInfraDegraded({
      identify,
      pick,
      submissionInvoked: null,
      sanityDegraded: false,
    }),
  };
}

function placeholderIdentify(): IdentifyResult {
  return {
    kind: 'uninformative',
    cause: 'short_circuit',
    reason: 'placeholder for parallel structure',
    trace: {
      pass: 'fast',
      llm_called: false,
      latency_ms: 0,
      model: null,
      status: 'skipped',
      web_search_used: false,
      evidence_mismatch: false,
    },
  };
}

function extractMerchantChapter(r: {
  state: string;
  resolved_code?: string;
}): string | null {
  if (
    r.state === 'active' ||
    r.state === 'replaced_single' ||
    r.state === 'override_applied' ||
    r.state === 'llm_picked_replacement' ||
    r.state === 'expanded_prefix'
  ) {
    return r.resolved_code ? r.resolved_code.slice(0, 2) : null;
  }
  return null;
}

function extractSecondaryCounts(
  scope: ScopeSelection,
  perArmCounts: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const arm of scope.secondaries) {
    result[arm.kind] = perArmCounts[arm.kind] ?? 0;
  }
  return result;
}
