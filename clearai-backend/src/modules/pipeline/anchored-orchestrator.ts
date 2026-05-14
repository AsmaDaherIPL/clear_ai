/**
 * Anchored pipeline orchestrator (PR-A-5).
 *
 * Wires the three anchored stages (identify → constrain → pick)
 * plus the legacy submission_description + sanity stages into a
 * PipelineResult matching the contract callers in pipeline.routes.ts
 * and dispatch.use-case.ts already consume.
 *
 * Flow:
 *
 *   parse (deterministic) - reused from legacy
 *     ↓
 *   identify (LLM + web, blinded to merchant code)
 *     ↓
 *   constrain (deterministic codebook walk + override + scope selector)
 *     ↓
 *   pick (scope-anchored retrieval + simplified picker)
 *     ↓ (only when pick.kind === 'accepted')
 *   submission_description (lightweight LLM, reused from legacy)
 *     ↓
 *   sanity (LLM, reused from legacy)
 *
 * Escalation routes:
 *   - pick.kind='escalate' → final_code=null, hitl=verdict_escalate.
 *     submission and sanity are skipped because they need a final_code.
 *   - sanity.verdict='FLAG' → final_code present, hitl=sanity_flag.
 *
 * infra_degraded propagation:
 *   - identify.kind='uninformative' with cause='transport' OR sanity.degraded
 *     OR submission.invoked='llm_failed'
 */
import { parseItem } from './parse/parse.js';
import { runIdentify } from './identify/identify.js';
import { runConstrain } from './constrain/constrain.js';
import { runPick } from './pick/pick.js';
import {
  generateSubmissionDescription,
  type SubmissionDescriptionResult,
} from './submission-description/submission-description.js';
import { runSanity } from './sanity/sanity.js';
import { lookupCatalogContext } from './catalog/catalog-context.js';
import { loadOperatorPipelineConfig } from './catalog/operator-pipeline-config.js';
import { buildTrace } from './trace/trace.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type {
  PipelineResult,
  StageTrace,
  HitlIntent,
} from './shared/pipeline.types.js';
import type { IdentifyResult } from './identify/identify.types.js';
import type { PickResult } from './pick/pick.types.js';

/**
 * Decide infra_degraded based on stage outputs. Mirrors the legacy
 * detectInfraDegraded semantics: an LLM stage exhausted its retry
 * budget and degraded rather than producing a real judgement.
 *
 * Anchored sources of degradation:
 *  - identify.cause === 'transport' (LLM error/timeout)
 *  - submission.invoked === 'llm_failed' (submission's only degraded variant —
 *    'fallback' and 'fallback_after_collision' are deterministic recoveries,
 *    not infra problems)
 *  - sanity.degraded === true (sanity's own degraded flag)
 *
 * NOT degraded for legitimate ZERO_SIGNAL escalations
 * (identify.cause === 'genuine' / 'short_circuit' / 'contract'),
 * pick.kind === 'escalate' reasons that aren't transport, or
 * picker_unavailable with status='parse' (parse failure is a model-
 * output issue, not an infra one — same as legacy semantics for
 * picker parse failures).
 */
function detectInfraDegraded(params: {
  identify: IdentifyResult;
  pick: PickResult | null;
  submissionInvoked: SubmissionDescriptionResult['invoked'] | null;
  sanityDegraded: boolean;
}): boolean {
  if (params.identify.kind === 'uninformative' && params.identify.cause === 'transport') {
    return true;
  }
  if (params.pick !== null && params.pick.kind === 'escalate' && params.pick.reason === 'picker_unavailable') {
    // Only the transport sub-cases are infra-degraded; parse is a
    // model-output issue. Read trace.status to discriminate.
    if (params.pick.trace.status === 'error' || params.pick.trace.status === 'timeout') {
      return true;
    }
  }
  if (params.submissionInvoked === 'llm_failed') {
    return true;
  }
  if (params.sanityDegraded) return true;
  return false;
}

/**
 * Run the anchored pipeline end-to-end. Mirrors runLegacyPipeline's
 * public contract (CanonicalLineItem → PipelineResult).
 */
export async function runAnchoredPipeline(
  item: CanonicalLineItem,
  operatorSlug: string,
  _itemId: string,
): Promise<PipelineResult> {
  const allStages: StageTrace[] = [];

  // ---- Stage 0a: Parse ----
  const t0a = Date.now();
  const parsed = parseItem(item);
  allStages.push({
    name: 'stage-0a/parse',
    started_at: new Date(t0a).toISOString(),
    duration_ms: Date.now() - t0a,
    outcome: 'ok',
    detail: parsed.rejected
      ? { rejected: true, reason: parsed.reason }
      : {
          rejected: false,
          merchant_code_state: parsed.item.merchant_code_state,
        },
  });

  // Parse can reject the item upstream (malformed inputs the pipeline
  // refuses to even attempt). Same path as legacy — sanity_verdict
  // BLOCK is reserved for these cases.
  if (parsed.rejected) {
    const trace = buildTrace({
      sanity: null,
      stages: allStages,
      pipelineArchitecture: 'anchored',
    });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'BLOCK',
      trace,
      hitl: null,
      infra_degraded: false,
    };
  }

  // Narrow raw_description from `string | null` to `string` for the
  // rest of the function. Parse only accepts when description is
  // present (parse.ts rejects with reason='no_description' otherwise),
  // so a null here is a programmer error in parse — assert rather
  // than silently mask with `!`.
  const rawDescription = parsed.item.raw_description;
  if (rawDescription === null) {
    throw new Error(
      'anchored-orchestrator invariant: parse accepted but raw_description is null',
    );
  }

  // ---- Stage 1: Identify ----
  // Blinded to the merchant code (rationale: anchoring avoidance).
  const t1 = Date.now();
  const identify = await runIdentify(rawDescription);
  allStages.push({
    name: 'stage-1/identify',
    started_at: new Date(t1).toISOString(),
    duration_ms: identify.trace.latency_ms,
    outcome: identify.trace.status === 'ok' || identify.trace.status === 'skipped' ? 'ok' : 'failed',
    detail: {
      kind: identify.kind,
      llm_called: identify.trace.llm_called,
      web_search_used: identify.trace.web_search_used,
      ...(identify.trace.evidence_mismatch ? { evidence_mismatch: true } : {}),
      ...(identify.kind === 'clean_product'
        ? {
            family_chapter: identify.family_chapter,
            identity_token_count: identify.identity_tokens.length,
            confidence: identify.confidence,
            evidence: identify.evidence,
          }
        : {}),
      ...(identify.kind === 'uninformative' ? { cause: identify.cause } : {}),
      ...(identify.kind === 'multi_product' ? { product_count: identify.products.length } : {}),
    },
  });

  // ---- Stage 2: Constrain ----
  const t2 = Date.now();
  // Load operator-scoped pipeline config (overrides_enabled flag).
  // Shared with legacy via catalog/operator-pipeline-config.ts.
  const opConfig = await loadOperatorPipelineConfig(operatorSlug);
  const constrain = await runConstrain({
    identify,
    raw_merchant_code: parsed.item.raw_merchant_code,
    operator_slug: operatorSlug,
    overrides_enabled: opConfig.overridesEnabled,
  });
  allStages.push({
    name: 'stage-2/constrain',
    started_at: new Date(t2).toISOString(),
    duration_ms: constrain.trace.latency_ms,
    outcome: 'ok',
    detail: {
      resolution_state: constrain.resolution.state,
      scope_kind: constrain.scope.kind,
      llm_called: constrain.trace.llm_called,
      override_attempted: constrain.trace.override_attempted,
      override_matched: constrain.trace.override_matched,
    },
  });

  // ---- Stage 3: Pick ----
  const t3 = Date.now();
  const pick = await runPick({ identify, constrain });
  allStages.push({
    name: 'stage-3/pick',
    started_at: new Date(t3).toISOString(),
    duration_ms: pick.trace.latency_ms,
    outcome: pick.trace.status === 'ok' || pick.trace.status === 'skipped' ? 'ok' : 'failed',
    detail: {
      kind: pick.kind,
      candidate_count: pick.trace.candidate_count,
      llm_called: pick.trace.llm_called,
      audit_flag: pick.trace.audit_flag,
      ...(pick.kind === 'accepted'
        ? {
            final_code: pick.final_code,
            fit: pick.fit,
            confidence: pick.confidence,
            gir_applied: pick.gir_applied,
          }
        : { escalate_reason: pick.reason }),
    },
  });

  // Pick escalated → skip submission + sanity, build escalate result.
  if (pick.kind === 'escalate') {
    const trace = buildTrace({
      anchoredIdentify: identify,
      anchoredConstrain: constrain,
      anchoredPick: pick,
      sanity: null,
      stages: allStages,
      pipelineArchitecture: 'anchored',
    });
    // HITL reason mapping. Legacy reserved `low_information` for the
    // "researcher cleanly gave up AND the description is too thin to
    // act on" path — different reviewer SLA and queue routing from a
    // generic escalation. Under anchored that maps to:
    //   identify.kind='uninformative' with cause='genuine'
    //   (LLM saw the input clearly and judged it unclassifiable;
    //    NOT transport/contract/short_circuit failures), AND
    //   pick.reason='identify_no_query' (pick refused to call the
    //    LLM because buildQuery returned empty under that identify).
    // Every other escalate path keeps `verdict_escalate`.
    const isLowInformation =
      identify.kind === 'uninformative' &&
      identify.cause === 'genuine' &&
      pick.reason === 'identify_no_query';
    const hitlReason: HitlIntent['reason'] = isLowInformation
      ? 'low_information'
      : 'verdict_escalate';
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'PASS',
      trace,
      hitl: {
        reason: hitlReason,
        // Reviewers need the most-tariff-readable form. Prefer the
        // canonical from identify when available; otherwise the raw
        // merchant string is the only signal we have.
        cleaned_description: identify.kind === 'clean_product' ? identify.canonical : rawDescription,
      },
      infra_degraded: detectInfraDegraded({
        identify,
        pick,
        submissionInvoked: null,
        sanityDegraded: false,
      }),
    };
  }

  // ---- Stage 4: Submission description ----
  // Reaching this point implies pick.kind === 'accepted', which under
  // pick.ts only happens when identify.kind === 'clean_product' (see
  // pick.ts: the `identify_no_query` short-circuit escalates when
  // buildQuery returns empty, which it does for every non-clean
  // variant). Narrow the type explicitly so we get identify.canonical
  // and identify.identity_tokens directly — no defensive fallback.
  if (identify.kind !== 'clean_product') {
    throw new Error(
      `anchored-orchestrator invariant: pick.accepted requires identify.clean_product, got kind=${identify.kind}`,
    );
  }
  const t4 = Date.now();
  const catalog = await lookupCatalogContext(pick.final_code);
  const cleanedForSubmission = identify.canonical;
  const submission = await generateSubmissionDescription({
    cleanedDescription: cleanedForSubmission,
    rawDescription,
    chosenCode: pick.final_code,
    catalogLeafAr: catalog.leafAr,
    catalogLeafEn: catalog.leafEn,
    catalogPathAr: catalog.pathAr,
    catalogPathEn: catalog.pathEn,
    // PR6: identity_tokens preserved into the submission description
    // (book titles, ingredient names, brand-as-chapter identifiers).
    identityTokens: identify.identity_tokens,
  });
  allStages.push({
    name: 'stage-4/submission-description',
    started_at: new Date(t4).toISOString(),
    duration_ms: submission.latencyMs,
    outcome: 'ok',
    detail: { source: submission.invoked, length: submission.descriptionAr.length },
  });

  // ---- Stage 5: Sanity ----
  const t5 = Date.now();
  const sanity = await runSanity({
    final_code: pick.final_code,
    cleaned_description: cleanedForSubmission,
    raw_description: rawDescription,
    value_amount:
      typeof item.valueAmountSar === 'number' && Number.isFinite(item.valueAmountSar)
        ? item.valueAmountSar
        : parsed.item.value_amount,
    currency_code: 'SAR',
  });
  allStages.push({
    name: 'stage-5/sanity',
    started_at: new Date(t5).toISOString(),
    duration_ms: sanity.latency_ms,
    outcome: 'ok',
    detail: {
      verdict: sanity.verdict,
      ...(sanity.degraded ? { degraded: true } : {}),
      ...(sanity.attempts !== undefined ? { attempts: sanity.attempts } : {}),
    },
  });

  const trace = buildTrace({
    anchoredIdentify: identify,
    anchoredConstrain: constrain,
    anchoredPick: pick,
    sanity,
    stages: allStages,
    pipelineArchitecture: 'anchored',
  });

  const hitl: HitlIntent | null = sanity.verdict === 'FLAG'
    ? { reason: 'sanity_flag', cleaned_description: cleanedForSubmission }
    : null;

  return {
    final_code: pick.final_code,
    goods_description_ar: submission.descriptionAr,
    sanity_verdict: sanity.verdict,
    trace,
    hitl,
    infra_degraded: detectInfraDegraded({
      identify,
      pick,
      submissionInvoked: submission.invoked,
      sanityDegraded: sanity.degraded === true,
    }),
  };
}
