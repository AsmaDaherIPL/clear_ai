/**
 * Batch path entry. The single-shot route calls runPipeline directly;
 * this is the per-item chokepoint for /declaration-runs.
 *
 * `item.itemId` is canonical — must flow into classification_events.id
 * and declaration_run_items.id so /pipeline/trace/:id resolves either
 * source by the same uuid.
 */
import { runPipeline } from '../pipeline/pipeline.orchestrator.js';
import { assembleDispatchV1 } from '../pipeline/trace/dispatch-v1.js';
import { recordClassificationEvent } from '../pipeline/events/recorder.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { DispatchResult } from './dispatch.contract.js';

export async function dispatch(item: CanonicalLineItem): Promise<DispatchResult> {
  const itemId = item.itemId;
  const operatorSlug = item.operatorSlug;
  const operatorId = item.operatorId ?? null;

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const result = await runPipeline(item, operatorSlug, itemId);
  const completedAt = new Date().toISOString();

  const v1Response = assembleDispatchV1({
    itemId,
    operatorSlug,
    result,
    startedAt,
    completedAt,
  });

  // Best-effort: a recorder failure must not abort the dispatch result.
  void recordClassificationEvent({
    operatorId,
    operatorSlug,
    request: {
      item_id: itemId,
      operator_slug: operatorSlug,
      description: item.description,
      merchant_code: item.merchantHsCode,
      value_amount: item.valueAmount,
      currency_code: item.currencyCode,
    },
    response: v1Response,
    totalLatencyMs: Date.now() - startedAtMs,
  });

  const hasA = !!result.trace.track_a?.chosen_code;
  const hasB = !!result.trace.track_b?.resolved_code;
  const pathTaken = hasA && hasB ? 'two_signal' : hasA ? 'single_a' : hasB ? 'single_b' : 'zero';

  const itemTrace = {
    pathTaken,
    stages: result.trace.stages.map((s) => ({
      name: s.name,
      startedAt: s.started_at,
      durationMs: s.duration_ms,
      outcome: s.outcome,
      detail: s.detail,
    })),
    meta: {
      track_a: result.trace.track_a,
      track_b: result.trace.track_b,
      verdict: result.trace.verdict,
      sanity: result.trace.sanity,
    },
  };

  return {
    finalCode: result.final_code ?? '',
    goodsDescriptionAr: result.goods_description_ar ?? '',
    sanityVerdict: result.sanity_verdict,
    trace: itemTrace,
  };
}
