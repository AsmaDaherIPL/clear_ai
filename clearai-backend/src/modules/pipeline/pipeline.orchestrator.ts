/**
 * Pipeline stages:
 *   0a    Parse                              (deterministic)
 *   0b    Cleanup                            (lightweight LLM)
 *   1     description_classifier             (researcher? → retrieval → threshold → picker)
 *   1     code_resolver                      (override → codebook → expand/LLM, parallel with 1)
 *   2     Reconciliation                     (standard LLM when needed)
 *   2.5   Submission description             (lightweight LLM, ≤300 char Arabic)
 *   3     Sanity                             (standard LLM, always)
 */
import { parseItem } from './parse/parse.js';
import { runCleanup } from './cleanup/cleanup.js';
import { runDescriptionClassifier } from './classify/description-classifier/description-classifier.js';
import { runCodeResolver } from './classify/code-resolver/code-resolver.js';
import { runReconciliation } from './classify/reconciliation/reconciliation.js';
import { generateSubmissionDescription } from './submission-description/submission-description.js';
import { runSanity } from './sanity/sanity.js';
import { shouldEnqueue } from './review/review.js';
import { buildTrace } from './trace/trace.js';
import { getPool } from '../../db/client.js';
import { env } from '../../config/env.js';
import { runAnchoredPipeline } from './anchored-orchestrator.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import { getLlmStagePolicy } from '../../inference/llm/policy.js';
import type {
  PipelineResult,
  StageTrace,
  HitlIntent,
  StageVerdictOutput,
  DescriptionClassifierResult,
} from './shared/pipeline.types.js';

/**
 * Pipeline architecture selector. Used by runPipeline to branch between
 * the legacy parallel-tracks design and the anchored three-stage design
 * during the migration window. Mirrors env.PIPELINE_ARCHITECTURE.
 */
export type PipelineArchitecture = 'legacy' | 'anchored';

export interface RunPipelineOptions {
  /**
   * Per-call architecture override. When set, wins over the env flag
   * env.PIPELINE_ARCHITECTURE. Used by /classifications/dispatch's
   * `?architecture=...` query param so a single classification can be
   * routed to the anchored pipeline for ad-hoc testing without
   * flipping the global default.
   *
   * Batch dispatch (modules/dispatch/dispatch.use-case.ts) deliberately
   * does NOT surface this option — batches consume the env flag for
   * consistent semantics across all rows in the same upload. Per-call
   * override is for ad-hoc single-shot testing only.
   */
  architectureOverride?: PipelineArchitecture;
}

/** Token count for the low-info gate. ≤ this many → too thin to retrieve. */
const LOW_INFO_TOKEN_THRESHOLD = 4;

/**
 * True when Track A had to call the researcher and the researcher gave
 * up, AND the cleaned description has too few content tokens for
 * retrieval to be defensible. In this state Track A's candidates are
 * pattern-matched noise; pushing them into reconciliation produces a
 * confident-looking wrong answer. Better to escalate early.
 *
 * The conjunction matters — short descriptions ARE fine when the
 * researcher recognized them ("wireless headphones" works at 2 tokens
 * because the researcher fills in tariff context). The failure mode is
 * specifically: researcher tried and couldn't, AND we're left with raw
 * thin text.
 */
export function shouldEscalateLowInformation(trackA: DescriptionClassifierResult, cleanedDescription: string): boolean {
  // Researcher must have actually run. If clarity_verdict was 'clear'
  // upstream, research is null and we don't apply this gate.
  if (!trackA.research) return false;
  // Researcher must have failed to identify the product. Recognized
  // products mean the enriched_description is the LLM's tariff-vocab
  // rewrite, which retrieval can work with even if short.
  if (trackA.research.recognised) return false;
  // If a web research pass succeeded, trust its output and continue.
  if (trackA.web_research && trackA.web_research.recognised) return false;
  // Description must be too thin. Count content tokens (≥ 2 chars after
  // stripping punctuation) so noise like "+", ",", "-" doesn't inflate.
  const contentTokens = cleanedDescription
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9؀-ۿ]/g, ''))
    .filter((t) => t.length >= 2);
  return contentTokens.length <= LOW_INFO_TOKEN_THRESHOLD;
}

/**
 * True when any LLM-backed stage exhausted its retry budget and degraded
 * (graceful_degrade) rather than producing a fresh judgement. Signals to
 * the classification service that the row should be recorded as
 * 'pending_infra' rather than the usual 'succeeded' / 'flagged' / 'failed'.
 *
 * Inputs come from local state the orchestrator already has visibility
 * into. We pass picker-stage details via the stage trace because the
 * picker output is not propagated up onto DescriptionClassifierResult.
 *
 * Never trips on healthy paths or on real ZERO_SIGNAL low-information
 * escalations — those carry no infra degradation marker.
 */
function detectInfraDegraded(input: {
  cleanupDegraded: boolean;
  sanityDegraded: boolean;
  trackA: DescriptionClassifierResult | null;
  pickerAttempts: number | null;
  pickerNoFit: boolean | null;
  retrievalCandidateCount: number | null;
  submissionInvoked: string | null;
}): boolean {
  if (input.cleanupDegraded) return true;
  if (input.sanityDegraded) return true;
  if (
    input.trackA?.research?.recognised === false &&
    input.trackA.research.source === 'failed_passthrough'
  ) {
    return true;
  }
  const pickerMax = getLlmStagePolicy('picker').maxAttempts;
  if (
    input.pickerAttempts !== null &&
    input.pickerAttempts >= pickerMax &&
    input.pickerNoFit === true &&
    (input.retrievalCandidateCount ?? 0) > 0
  ) {
    return true;
  }
  if (input.submissionInvoked === 'llm_failed') return true;
  return false;
}

/** Pull picker detail off the stage trace (description-classifier writes it). */
function readPickerStageDetail(stages: StageTrace[]): {
  attempts: number | null;
  noFit: boolean | null;
  retrievalCandidateCount: number | null;
} {
  let attempts: number | null = null;
  let noFit: boolean | null = null;
  let retrievalCandidateCount: number | null = null;
  for (const s of stages) {
    if (s.name === 'track-a/picker' && s.detail && typeof s.detail === 'object') {
      const d = s.detail as { attempts?: number; no_fit?: boolean };
      if (typeof d.attempts === 'number') attempts = d.attempts;
      if (typeof d.no_fit === 'boolean') noFit = d.no_fit;
    }
    if (
      (s.name === 'track-a/retrieval' || s.name === 'track-a/retrieval-after-web') &&
      s.detail &&
      typeof s.detail === 'object'
    ) {
      const d = s.detail as { candidate_count?: number };
      if (typeof d.candidate_count === 'number') {
        // Last retrieval wins — that's the one the picker actually saw.
        retrievalCandidateCount = d.candidate_count;
      }
    }
  }
  return { attempts, noFit, retrievalCandidateCount };
}

interface OperatorPipelineConfig {
  /** Defaults to true when no operator_declaration_config row exists yet. */
  overridesEnabled: boolean;
}

async function loadOperatorPipelineConfig(operatorSlug: string): Promise<OperatorPipelineConfig> {
  const pool = getPool();
  const r = await pool.query<{
    overrides_enabled: boolean | null;
  }>(
    `SELECT c.overrides_enabled
       FROM operator_declaration_config c
       JOIN operators o ON o.id = c.operator_id
      WHERE o.slug = $1`,
    [operatorSlug],
  );
  const row = r.rows[0];
  return {
    // Default to true when the column is null (older rows) or the row is
    // missing entirely — preserves historical behavior.
    overridesEnabled: row?.overrides_enabled ?? true,
  };
}

interface CatalogContext {
  /** Leaf Arabic from zatca_hs_codes.description_ar. Same string the breadcrumb terminates with. */
  leafAr: string | null;
  /** Leaf English. */
  leafEn: string | null;
  /** Breadcrumb path through the tariff tree (chapter > heading > hs6 > leaf), Arabic. */
  pathAr: string | null;
  /** Breadcrumb path, English. */
  pathEn: string | null;
}

async function lookupCatalogContext(code: string): Promise<CatalogContext> {
  const pool = getPool();
  const r = await pool.query<{
    description_ar: string | null;
    description_en: string | null;
    path_ar: string | null;
    path_en: string | null;
  }>(
    `SELECT c.description_ar, c.description_en, d.path_ar, d.path_en
       FROM zatca_hs_codes c
       LEFT JOIN zatca_hs_code_display d ON d.code = c.code
      WHERE c.code = $1`,
    [code],
  );
  const row = r.rows[0];
  return {
    leafAr: row?.description_ar ?? null,
    leafEn: row?.description_en ?? null,
    pathAr: row?.path_ar ?? null,
    pathEn: row?.path_en ?? null,
  };
}

/**
 * Public pipeline entry. Branches on the configured architecture:
 * 'legacy' runs the existing parallel-tracks pipeline; 'anchored' delegates
 * to runAnchoredPipeline (stub until PR-A-5).
 *
 * Per-call override (opts.architectureOverride) wins over the env flag.
 * `opts` is required so both call sites — single-shot
 * /classifications/dispatch and batch dispatch.use-case — state intent
 * explicitly (per the codebase's no-defensive-defaults rule). Pass `{}`
 * to inherit the env flag.
 */
export async function runPipeline(
  item: CanonicalLineItem,
  operatorSlug: string,
  itemId: string,
  opts: RunPipelineOptions,
): Promise<PipelineResult> {
  const architecture: PipelineArchitecture =
    opts.architectureOverride ?? env().PIPELINE_ARCHITECTURE;

  if (architecture === 'anchored') {
    return runAnchoredPipeline(item, operatorSlug, itemId);
  }

  return runLegacyPipeline(item, operatorSlug, itemId);
}

/**
 * @internal — must not be exported outside this module.
 * Routing through `runPipeline` is the only valid entry to the legacy
 * pipeline; bypassing it silently skips the architecture flag check.
 */

/**
 * Legacy pipeline body. Kept under its own name so the new
 * `runPipeline` can route to it without losing the existing call shape.
 * After the anchored-pipeline cutover (PR-A-7) and cleanup (PR-A-8),
 * this function is deleted and `runPipeline` becomes the anchored
 * implementation directly.
 */
async function runLegacyPipeline(
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
    detail: {
      rejected: parsed.rejected,
      ...(parsed.rejected
        ? {}
        : {
            merchant_code_state: parsed.item.merchant_code_state,
            raw_merchant_code: parsed.item.raw_merchant_code,
            // raw_description: the merchant's verbatim text. Surfaced in the
            // parse-stage trace so audit reviewers can see what the merchant
            // sent vs. what Stage 0b cleanup turned it into (effective_description
            // in track-a/retrieval). Useful when classification looks wrong and
            // we need to know whether cleanup mangled the input.
            raw_description: parsed.item.raw_description,
            currency_code: parsed.item.currency_code,
            value_amount: parsed.item.value_amount,
          }),
    },
  });

  if (parsed.rejected) {
    const trace = buildTrace({ trackA: null, trackB: null, verdict: null, sanity: null, stages: allStages, pipelineArchitecture: 'legacy' });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'BLOCK',
      trace,
      hitl: null,
      infra_degraded: false,
    };
  }

  const parsedItem = parsed.item;

  // ---- Stage 0b: Cleanup ----
  const t0b = Date.now();
  const cleanup = await runCleanup(parsedItem.raw_description!, parsedItem.identifiers);
  allStages.push({
    name: 'stage-0b/cleanup',
    started_at: new Date(t0b).toISOString(),
    duration_ms: cleanup.latency_ms,
    outcome: 'ok',
    detail: {
      clarity_verdict: cleanup.clarity_verdict,
      degraded: cleanup.degraded,
      attempts: cleanup.attempts,
      ...(cleanup.identity_tokens.length > 0
        ? { identity_tokens: cleanup.identity_tokens }
        : {}),
      ...(cleanup.retried_reasons.length > 0
        ? { retried_reasons: cleanup.retried_reasons }
        : {}),
    },
  });

  // Unusable description — reject before tracks.
  if (cleanup.clarity_verdict === 'unusable') {
    const trace = buildTrace({ trackA: null, trackB: null, verdict: null, sanity: null, stages: allStages, pipelineArchitecture: 'legacy' });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'BLOCK',
      trace,
      hitl: null,
      // Cleanup degradation can leave clarity_verdict='unusable' even when
      // the LLM exhausted retries (degraded=true forces a passthrough that
      // the model may then mark unusable). Mark this row as infra-degraded
      // when that's the cause; an unusable verdict from a healthy cleanup
      // call is a real data issue.
      infra_degraded: cleanup.degraded === true,
    };
  }

  // ---- Load per-operator pipeline config (gate + overrides flag) ----
  // Single query that returns both fields, fired in parallel with Tracks A+B
  // so the orchestrator critical path doesn't wait sequentially. Track B
  // needs `overridesEnabled` before it calls lookupTenantOverride().
  const operatorConfigPromise = loadOperatorPipelineConfig(operatorSlug);

  // ---- Tracks A and B (concurrent) ----
  // Track B awaits the operator config first; Track A is independent.
  const [trackAOut, trackBResult] = await Promise.all([
    runDescriptionClassifier(cleanup, parsedItem.raw_description!),
    operatorConfigPromise.then((cfg) =>
      runCodeResolver(
        parsedItem.raw_merchant_code,
        parsedItem.merchant_code_state,
        cleanup.cleaned_description,
        operatorSlug,
        { overridesEnabled: cfg.overridesEnabled },
      ),
    ),
  ]);

  allStages.push(...trackAOut.stages);
  const trackAResult = trackAOut.result;

  // ---- Low-information escalation gate ----
  // When the researcher ran AND gave up (recognised=false from the cheap
  // LLM, no successful web research), AND the cleaned description is too
  // thin for retrieval to be reliable, refuse to classify. Track A's
  // candidates in this state are pure pattern-match noise (see
  // 'B6(Black)+Blue case' → 'Smart secure bags with GPS' run for the
  // canonical failure). Reconciliation would force a guess based on that
  // noise; sanity FLAG would catch *price* but not the wrong code. Better
  // to escalate to HITL early with the raw input intact.
  if (shouldEscalateLowInformation(trackAResult, cleanup.cleaned_description)) {
    const escalateVerdict: StageVerdictOutput = {
      decision: 'escalate',
      disagreement_summary:
        'LOW_INFORMATION: researcher could not identify the product and the description is too thin for retrieval. ' +
        'Reconciliation would be guessing; routing to HITL.',
      classification_status: 'ZERO_SIGNAL',
      conflict_type: 'ZERO_SIGNAL',
    };
    allStages.push({
      name: 'stage-2/reconciliation',
      started_at: new Date().toISOString(),
      duration_ms: 0,
      outcome: 'skipped',
      detail: { decision: 'escalate', reason: 'low_information' },
    });
    const trace = buildTrace({
      trackA: trackAResult,
      trackB: trackBResult,
      verdict: escalateVerdict,
      sanity: null,
      stages: allStages,
      pipelineArchitecture: 'legacy',
    });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'FLAG',
      trace,
      hitl: {
        reason: 'low_information',
        cleaned_description: cleanup.cleaned_description,
      },
      // Real ZERO_SIGNAL — researcher tried, description was too thin.
      // Not an infra fault; reviewer needs to enrich the input.
      infra_degraded: false,
    };
  }

  // ---- Stage 2: Reconciliation ----
  const t2 = Date.now();
  const verdict = await runReconciliation(trackAResult, trackBResult, cleanup.cleaned_description);
  allStages.push({
    name: 'stage-2/reconciliation',
    started_at: new Date(t2).toISOString(),
    duration_ms: Date.now() - t2,
    outcome: 'ok',
    detail: { decision: verdict.decision },
  });

  // Escalate to HITL — item still progresses as 'flagged'. This is the ONLY
  // escalation path now; the per-operator min_confidence_band gate was
  // removed in 0072_drop_confidence_band. ZERO_SIGNAL and degenerate-DRIFT
  // escalations both flow through verdict.decision === 'escalate'.
  if (verdict.decision === 'escalate') {
    const trace = buildTrace({ trackA: trackAResult, trackB: trackBResult, verdict, sanity: null, stages: allStages, pipelineArchitecture: 'legacy' });
    const pickerDetail = readPickerStageDetail(allStages);
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'FLAG',
      trace,
      hitl: {
        reason: 'verdict_escalate',
        cleaned_description: cleanup.cleaned_description,
      },
      infra_degraded: detectInfraDegraded({
        cleanupDegraded: cleanup.degraded === true,
        sanityDegraded: false,
        trackA: trackAResult,
        pickerAttempts: pickerDetail.attempts,
        pickerNoFit: pickerDetail.noFit,
        retrievalCandidateCount: pickerDetail.retrievalCandidateCount,
        submissionInvoked: null,
      }),
    };
  }

  // ---- Stage 2.5: Submission description (lightweight LLM) ----
  const t25 = Date.now();
  const catalog = await lookupCatalogContext(verdict.final_code);
  const submission = await generateSubmissionDescription({
    cleanedDescription: cleanup.cleaned_description,
    rawDescription: parsedItem.raw_description!,
    chosenCode: verdict.final_code,
    catalogLeafAr: catalog.leafAr,
    catalogLeafEn: catalog.leafEn,
    catalogPathAr: catalog.pathAr,
    catalogPathEn: catalog.pathEn,
    // PR6: thread cleanup's identity_tokens through so the submission
    // prompt can preserve book titles, ingredient names, brand-as-
    // chapter identifiers in the ZATCA goods description.
    identityTokens: cleanup.identity_tokens,
  });
  allStages.push({
    name: 'stage-2.5/submission-description',
    started_at: new Date(t25).toISOString(),
    duration_ms: submission.latencyMs,
    outcome: 'ok',
    detail: { source: submission.invoked, length: submission.descriptionAr.length },
  });

  // ---- Stage 3: Sanity ----
  const t3 = Date.now();
  const sanity = await runSanity({
    final_code: verdict.final_code,
    cleaned_description: cleanup.cleaned_description,
    // The brand / model / SKU live only in the raw merchant line — cleanup
    // strips them by design. Sanity needs them to pick the right retail
    // band ($30 Timex vs $300 Casio Pro Trek vs $5000 Rolex are all
    // "digital watch" once cleaned).
    raw_description: parsedItem.raw_description ?? null,
    // Always pass SAR for the value, regardless of the merchant's source
    // currency. Sanity bands are SAR-anchored; parse stamps valueAmountSar.
    // Fall back to legacy value_amount when SAR field is absent (pre 0076 row).
    value_amount:
      typeof item.valueAmountSar === 'number' && Number.isFinite(item.valueAmountSar)
        ? item.valueAmountSar
        : parsedItem.value_amount,
    currency_code: 'SAR',
  });
  allStages.push({
    name: 'stage-3/sanity',
    started_at: new Date(t3).toISOString(),
    duration_ms: sanity.latency_ms,
    outcome: 'ok',
    detail: {
      verdict: sanity.verdict,
      ...(sanity.degraded ? { degraded: true } : {}),
      ...(sanity.attempts !== undefined ? { attempts: sanity.attempts } : {}),
      ...(sanity.retried_reasons && sanity.retried_reasons.length > 0
        ? { retried_reasons: sanity.retried_reasons }
        : {}),
    },
  });

  const trace = buildTrace({ trackA: trackAResult, trackB: trackBResult, verdict, sanity, stages: allStages, pipelineArchitecture: 'legacy' });

  const hitl: HitlIntent | null = shouldEnqueue(verdict, sanity)
    ? { reason: 'sanity_flag', cleaned_description: cleanup.cleaned_description }
    : null;

  // Sanity is value-plausibility only and emits PASS | FLAG. The code is
  // already decided by Stage 2 reconciliation; FLAG just routes to HITL
  // with the code intact. BLOCK on PipelineResult.sanity_verdict is
  // reserved for the upstream parse / cleanup-unusable rejections above
  // (lines ~85-115); the LLM never produces it.
  // The route handler writes hitl_queue after classification_events so
  // the FK from hitl_queue.classification_event_id is satisfied.
  const pickerDetail = readPickerStageDetail(allStages);
  return {
    final_code: verdict.final_code,
    goods_description_ar: submission.descriptionAr,
    sanity_verdict: sanity.verdict,
    trace,
    hitl,
    infra_degraded: detectInfraDegraded({
      cleanupDegraded: cleanup.degraded === true,
      sanityDegraded: sanity.degraded === true,
      trackA: trackAResult,
      pickerAttempts: pickerDetail.attempts,
      pickerNoFit: pickerDetail.noFit,
      retrievalCandidateCount: pickerDetail.retrievalCandidateCount,
      submissionInvoked: submission.invoked,
    }),
  };
}
