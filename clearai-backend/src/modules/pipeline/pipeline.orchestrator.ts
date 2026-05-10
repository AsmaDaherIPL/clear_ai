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
import { parseItem } from './stage-0-parse/parse.js';
import { runCleanup } from './stage-1-cleanup/cleanup.js';
import { runTrackA } from './track-a-description/track-a.js';
import { runTrackB } from './track-b-code/track-b.js';
import { runReconciliation } from './stage-2-verdict/reconciliation.js';
import { generateSubmissionDescription } from './submission-description/submission-description.js';
import { runSanity } from './stage-3-sanity/sanity.js';
import { shouldEnqueue } from './hitl/hitl.js';
import { buildTrace } from './trace/trace.js';
import { getPool } from '../../db/client.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { PipelineResult, StageTrace, HitlIntent, ConfidenceBand, VerdictResult } from './shared/pipeline.types.js';

const BAND_RANK: Record<ConfidenceBand, number> = {
  certain: 4,
  high:    3,
  medium:  2,
  low:     1,
  none:    0,
};

async function loadMinConfidenceBand(operatorSlug: string): Promise<ConfidenceBand | null> {
  const pool = getPool();
  const r = await pool.query<{ min_confidence_band: string | null }>(
    `SELECT c.min_confidence_band
       FROM operator_declaration_config c
       JOIN operators o ON o.id = c.operator_id
      WHERE o.slug = $1`,
    [operatorSlug],
  );
  const raw = r.rows[0]?.min_confidence_band ?? null;
  return raw as ConfidenceBand | null;
}

function isBelowGate(verdict: VerdictResult, minBand: ConfidenceBand): boolean {
  return BAND_RANK[verdict.confidence_band] < BAND_RANK[minBand];
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

export async function runPipeline(
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
    const trace = buildTrace({ trackA: null, trackB: null, verdict: null, sanity: null, stages: allStages });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'BLOCK',
      trace,
      hitl: null,
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
      hitl: null,
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
    detail: { decision: verdict.decision },
  });

  // Escalate to HITL — item still progresses as 'flagged'.
  if (verdict.decision === 'escalate') {
    const trace = buildTrace({ trackA: trackAResult, trackB: trackBResult, verdict, sanity: null, stages: allStages });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'FLAG',
      trace,
      hitl: {
        reason: 'verdict_escalate',
        cleaned_description: cleanup.cleaned_description,
      },
    };
  }

  // ---- Stage 2 gate: per-operator minimum confidence band ----
  const minBand = await loadMinConfidenceBand(operatorSlug);
  if (minBand && isBelowGate(verdict, minBand)) {
    const gateVerdict = {
      decision: 'escalate' as const,
      disagreement_summary: `confidence_band '${verdict.confidence_band}' is below operator minimum '${minBand}'`,
      // The PR 4 gate's escalation is operationally distinct from a
      // ZERO_SIGNAL escalation (we DID classify; the operator's policy
      // overrode it), but the conflict_type field only models the six
      // PR 6 reconciliation outcomes. Tag as ZERO_SIGNAL so the HITL
      // queue uniformly handles every escalate-decision row; the
      // disagreement_summary above carries the real reason.
      classification_status: 'ZERO_SIGNAL' as const,
      conflict_type: 'ZERO_SIGNAL' as const,
    };
    const trace = buildTrace({ trackA: trackAResult, trackB: trackBResult, verdict: gateVerdict, sanity: null, stages: allStages });
    return {
      final_code: null,
      goods_description_ar: null,
      sanity_verdict: 'FLAG',
      trace,
      hitl: {
        reason: 'verdict_escalate',
        cleaned_description: cleanup.cleaned_description,
      },
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
  return {
    final_code: verdict.final_code,
    goods_description_ar: submission.descriptionAr,
    sanity_verdict: sanity.verdict,
    trace,
    hitl,
  };
}
