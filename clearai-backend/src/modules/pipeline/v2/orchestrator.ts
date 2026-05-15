/**
 * Pipeline rewrite — Orchestrator (PR 11).
 *
 * Wires the new flow end-to-end:
 *
 *   parse (deterministic)
 *      ↓
 *   parallel { identify_fast, merchant_resolution }
 *      ↓
 *   if identify_fast.kind === uninformative+genuine OR multi_product:
 *     identify_web (replaces identify_fast)
 *      ↓
 *   scope_selection (deterministic)
 *      ↓
 *   if scope.primary.kind === escalate: short-circuit
 *      ↓
 *   multi-arm retrieval + dedupe (parallel arms)
 *      ↓
 *   reranker (deterministic, top 8)
 *      ↓
 *   picker (Sonnet, single call)
 *      ↓
 *   if pick.kind === escalate: short-circuit
 *      ↓
 *   verifier (deterministic, PASS / UNCERTAIN)
 *      ↓
 *   parallel { submission_description, sanity_check }
 *      ↓
 *   build PipelineResultV2 with HITL routing based on verify + sanity
 *
 * Replaces the PR 1 stub. Public signature unchanged.
 */
import { parseItem } from './parse.js';
import { runIdentifyFast } from './identify/fast.js';
import { runIdentifyWeb } from './identify/web.js';
import {
  resolveMerchant,
  buildResolutionTrace,
} from './merchant/resolve.js';
import { selectScopes } from './scope/select.js';
import { runMultiArmRetrieval } from './retrieve/multi-arm.js';
import { dedupeCandidates } from './retrieve/union.js';
import { rerank } from './retrieve/rerank.js';
import { runPick } from './pick/pick.js';
import { verifyClassification } from './pick/verify.js';
import { generateSubmissionDescription } from '../submission-description/submission-description.js';
import { runSanity } from '../sanity/sanity.js';
import { lookupCatalogContext } from '../catalog/catalog-context.js';
import { loadOperatorPipelineConfig } from '../catalog/operator-pipeline-config.js';
import type {
  CanonicalLineItem,
  ClassificationStatus,
  HitlIntent,
  IdentifyResult,
  PickResult,
  PipelineResultV2,
  PipelineTraceV2,
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
 * Mirrors current anchored derivation but adds verifier signal:
 *   pick escalate                          → ZERO_SIGNAL
 *   pick accepted + verify UNCERTAIN       → DRIFT
 *   pick accepted + verify PASS + clean_product + fits  → AGREEMENT
 *   anything else (partial fit, etc.)      → DRIFT
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
 *   sanity.verdict === 'BLOCK'    → null (BLOCK is terminal, no HITL queue)
 *   sanity.verdict === 'FLAG'     → 'sanity_flag'
 *   verify.result === 'UNCERTAIN' → 'verifier_uncertain'
 *   pick.escalate (any reason)    → 'verdict_escalate' or 'low_information'
 *                                   per identify.cause + pick.reason combo
 *   otherwise                     → null (accept clean)
 *
 * cleaned_description for the HITL payload is identify.canonical when
 * clean_product, else the raw description.
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
    // Distinguish low_information (identify gave up genuinely AND picker
    // had no query) from verdict_escalate (other failure modes).
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
 * transport-class failure that's recoverable on retry. Same semantics
 * as the legacy anchored orchestrator's detectInfraDegraded:
 *   - identify.cause === 'transport' (either pass)
 *   - picker_unavailable with status 'error' | 'timeout'
 *   - submission.invoked === 'llm_failed'
 *   - sanity.degraded === true
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
 * Public entry. Runs the rewritten pipeline end-to-end and returns a
 * PipelineResultV2.
 *
 * Never throws on stage-level failures — each stage returns a typed
 * union with escalate variants. Throws only on programmer error
 * (missing prompt file, schema invariant violation).
 */
export async function runPipelineV2(
  item: CanonicalLineItem,
  operatorSlug: string,
  _itemId: string,
): Promise<PipelineResultV2> {
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
    // We pass an identify "placeholder" because resolveMerchant needs the
    // identify result for some LLM-pick disambiguations. Since identify_fast
    // hasn't finished yet when this is constructed, we can't pass its real
    // result. The legacy resolve-merchant uses identify only for the
    // multi-replacement LLM pick path (rare), and the picker reads
    // identify.canonical when present. Passing an empty placeholder keeps
    // the parallel structure; the small accuracy loss on multi-replacement
    // disambiguation is acceptable in exchange for the latency win.
    // TODO PR-12 follow-up: investigate whether to serialize these stages
    // when merchant code requires multi-replacement disambiguation.
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
    /* llmCalled */ false, // placeholder; the real signal requires
    // surfacing it from resolveMerchantCode which is legacy and untouched
    /* overrideAttempted */ opConfig.overridesEnabled,
  );

  // ---- Stage 4: Scope selection ----
  const scope = selectScopes(identify, merchantResolution);

  if (scope.primary.kind === 'escalate') {
    // No retrieval, no picker. Build a minimal escalate result.
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
  // Build the query (identify.canonical + tokens for non-lexical arms).
  // The lexical arm overrides this internally with the tokens-only query.
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
  const trace: PipelineTraceV2 = {
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
    stages: [], // legacy compat field; populated by trace builder in PR 12
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

function blockedResult(reason: string): PipelineResultV2 {
  // Parse rejection. BLOCK is the appropriate sanity_verdict per the
  // legacy + anchored convention.
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
  merchantResolution: PipelineTraceV2['merchant_resolution']['resolution'];
  merchantResolutionTrace: PipelineTraceV2['merchant_resolution']['trace'];
  scope: ScopeSelection;
  pick: PickResult;
  rawDescription: string;
  retrievalStats?: PipelineTraceV2['retrieval'];
}): PipelineResultV2 {
  const {
    identify,
    merchantResolution,
    merchantResolutionTrace,
    scope,
    pick,
    rawDescription,
    retrievalStats,
  } = params;
  const trace: PipelineTraceV2 = {
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
    sanity_verdict: 'PASS', // escalate paths default to PASS (sanity never ran)
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
  // Used when merchant_resolution needs an identify arg but identify_fast
  // hasn't completed yet (parallel structure). resolveMerchantCode only
  // reads identify.canonical in the multi-replacement LLM-pick branch;
  // an empty placeholder keeps that branch's recall low but doesn't
  // crash. See TODO in runPipelineV2.
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
