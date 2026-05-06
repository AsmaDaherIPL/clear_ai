/**
 * Pipeline orchestrator — runs the full classification pipeline for a single
 * CanonicalLineItem.
 *
 * Stages:
 *   0a    Parse (deterministic)
 *   0b    Cleanup (lightweight LLM)
 *   1A    Track A: Researcher? → Retrieval → Threshold → Picker
 *   1B    Track B: Override → Codebook → Expand/LLM
 *   2     Reconciliation (standard LLM when needed)
 *   2.5   Submission description (lightweight LLM, ≤300 char Arabic)
 *   3     Sanity (standard LLM, always)
 *
 * Returns a PipelineResult that mirrors the DispatchResult contract so
 * declaration-runs/classification.service.ts can consume it without change.
 */
import { parseItem } from './stage-0-parse/parse.js';
import { runCleanup } from './stage-1-cleanup/cleanup.js';
import { runTrackA } from './track-a-description/track-a.js';
import { runTrackB } from './track-b-code/track-b.js';
import { runReconciliation } from './stage-2-verdict/reconciliation.js';
import { generateSubmissionDescription } from './submission-description/submission-description.js';
import { runSanity } from './stage-3-sanity/sanity.js';
import { enqueueHitl, shouldEnqueue } from './hitl/hitl.js';
import { buildTrace } from './trace/trace.js';
import { getPool } from '../../db/client.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { PipelineResult, StageTrace } from './shared/pipeline.types.js';

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

export async function runPipeline(
  item: CanonicalLineItem,
  operatorSlug: string,
  itemId: string,
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
    detail: { rejected: parsed.rejected },
  });

  if (parsed.rejected) {
    const trace = buildTrace({ trackA: null, trackB: null, verdict: null, sanity: null, stages: allStages });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'BLOCK',
      trace,
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
    detail: { clarity_verdict: cleanup.clarity_verdict, degraded: cleanup.degraded },
  });

  // Unusable description — reject before tracks.
  if (cleanup.clarity_verdict === 'unusable') {
    const trace = buildTrace({ trackA: null, trackB: null, verdict: null, sanity: null, stages: allStages });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'BLOCK',
      trace,
    };
  }

  // ---- Tracks A and B (concurrent) ----
  const [trackAOut, trackBResult] = await Promise.all([
    runTrackA(cleanup, parsedItem.raw_description!),
    runTrackB(
      parsedItem.raw_merchant_code,
      parsedItem.merchant_code_state,
      cleanup.cleaned_description,
      operatorSlug,
    ),
  ]);

  allStages.push(...trackAOut.stages);
  const trackAResult = trackAOut.result;

  // ---- Stage 2: Reconciliation ----
  const t2 = Date.now();
  const verdict = await runReconciliation(trackAResult, trackBResult, cleanup.cleaned_description);
  allStages.push({
    name: 'stage-2/reconciliation',
    started_at: new Date(t2).toISOString(),
    duration_ms: Date.now() - t2,
    outcome: 'ok',
    detail: { decision: verdict.decision, signal_count: verdict.signal_count },
  });

  // Escalate to HITL — item still progresses as 'flagged'.
  if (verdict.decision === 'escalate') {
    const trace = buildTrace({ trackA: trackAResult, trackB: trackBResult, verdict, sanity: null, stages: allStages });
    await enqueueHitl({
      item_id: itemId,
      operator_slug: operatorSlug,
      cleaned_description: cleanup.cleaned_description,
      verdict_output: verdict,
      sanity_result: null,
      trace,
      enqueued_at: new Date().toISOString(),
    });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'FLAG',
      trace,
    };
  }

  // ---- Stage 2.5: Submission description (lightweight LLM) ----
  const t25 = Date.now();
  const catalog = await lookupCatalogContext(verdict.final_code);
  const submission = await generateSubmissionDescription({
    cleanedDescription: cleanup.cleaned_description,
    chosenCode: verdict.final_code,
    catalogLeafAr: catalog.leafAr,
    catalogLeafEn: catalog.leafEn,
    catalogPathAr: catalog.pathAr,
    catalogPathEn: catalog.pathEn,
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
    value_amount: parsedItem.value_amount,
    currency_code: parsedItem.currency_code,
  });
  allStages.push({
    name: 'stage-3/sanity',
    started_at: new Date(t3).toISOString(),
    duration_ms: sanity.latency_ms,
    outcome: 'ok',
    detail: { verdict: sanity.verdict },
  });

  const trace = buildTrace({ trackA: trackAResult, trackB: trackBResult, verdict, sanity, stages: allStages });

  // HITL for FLAG or BLOCK
  if (shouldEnqueue(verdict, sanity)) {
    await enqueueHitl({
      item_id: itemId,
      operator_slug: operatorSlug,
      cleaned_description: cleanup.cleaned_description,
      verdict_output: verdict,
      sanity_result: sanity,
      trace,
      enqueued_at: new Date().toISOString(),
    });
  }

  // BLOCK — exclude from declaration phase
  if (sanity.verdict === 'BLOCK') {
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'BLOCK',
      trace,
    };
  }

  // PASS or FLAG — return with the LLM-generated submission description
  return {
    final_code: verdict.final_code,
    goods_description_ar: submission.descriptionAr,
    sanity_verdict: sanity.verdict,
    trace,
  };
}
