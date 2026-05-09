/**
 * Dispatch — pipeline entry point used by the batch path.
 *
 * The single-shot `/pipeline/dispatch` route calls runPipeline +
 * assembleDispatchV1 directly; this module is the chokepoint for the
 * BATCH path (modules/declaration-runs/classification/classification.service
 * iterates per-item and calls this function).
 *
 * Responsibilities:
 *   1. Run the 5-stage pipeline.
 *   2. Persist the result to classification_events (single source of
 *      truth for traces — see project rule). Best-effort: a recorder
 *      failure must not abort the dispatch result, since the batch
 *      path also writes a denormalised row to declaration_run_items
 *      for run lifecycle.
 *   3. Adapt PipelineResult → the legacy DispatchResult contract that
 *      the batch service consumes for its declaration_run_items writes.
 *
 * The id rule: `item.itemId` is canonical. classification_events.id,
 * declaration_run_items.id, and the response's item_id are all the
 * same uuid so /pipeline/trace/:id finds the row in classification_events
 * regardless of how it got there.
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

  // Build the dispatch-v1 wire shape so the recorder sees the same
  // structure single-shot dispatch does. We don't return this to the
  // batch caller — the batch contract still wants the legacy
  // DispatchResult — but we DO write it to classification_events so
  // /pipeline/trace/:id has a uniform store.
  const v1Response = assembleDispatchV1({
    itemId,
    operatorSlug,
    result,
    startedAt,
    completedAt,
  });

  // Best-effort. Failure logs but doesn't abort the dispatch.
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

  // Adapt PipelineTrace → ItemTrace (the existing batch contract shape).
  // pathTaken summarises which signals fired, derived from whether
  // each track produced a code. Used for the legacy ItemTrace contract
  // only; v1 callers should look at description_classifier_chosen_code
  // / code_resolver_resolved_code in the trace stages directly.
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
