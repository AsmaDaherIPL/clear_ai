/**
 * Batch path entry. The single-shot route calls runPipeline directly;
 * this is the per-item chokepoint for /declaration-runs.
 *
 * `item.itemId` is canonical — must flow into classification_events.id
 * and declaration_run_items.id so /pipeline/trace/:id resolves either
 * source by the same uuid.
 *
 * Refuses to start when the LLM circuit breaker is tripped (sustained
 * auth-class failures from Foundry — see ./../../inference/llm/breaker.ts).
 * Throws LlmUnavailableError; both the single-shot route and the batch
 * runner translate that into a 503 response / failed item rather than
 * silently producing low-confidence override-passthroughs while the env
 * is broken.
 */
import { runPipeline } from '../pipeline/pipeline.orchestrator.js';
import { assembleDispatchV1 } from '../pipeline/trace/dispatch-v1.js';
import { recordClassificationEvent } from '../pipeline/events/recorder.js';
import { enqueueHitl } from '../pipeline/hitl/hitl.js';
import { isBreakerTripped, breakerStatus } from '../../inference/llm/breaker.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { DispatchResult } from './dispatch.contract.js';

export class LlmUnavailableError extends Error {
  readonly code = 'llm_unavailable';
  readonly trippedAtMs: number | null;
  readonly lastError: string | null;
  constructor() {
    const status = breakerStatus();
    super(
      `LLM circuit breaker tripped after sustained auth-class failures. ` +
        `Last error: ${status.last_error ?? 'unknown'}.`,
    );
    this.name = 'LlmUnavailableError';
    this.trippedAtMs = status.tripped_at_ms;
    this.lastError = status.last_error;
  }
}

export async function dispatch(item: CanonicalLineItem): Promise<DispatchResult> {
  if (isBreakerTripped()) {
    throw new LlmUnavailableError();
  }
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

  // Persist the audit row first (FK target for the queue), then the
  // queue write if the orchestrator surfaced HITL intent. Both
  // best-effort; failures don't abort the dispatch result.
  const eventOk = await recordClassificationEvent({
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

  if (eventOk && result.hitl) {
    await enqueueHitl({
      classification_event_id: itemId,
      item_id: itemId,
      operator_slug: operatorSlug,
      reason: result.hitl.reason,
      cleaned_description: result.hitl.cleaned_description,
      verdict_output: result.trace.verdict,
      sanity_result: result.trace.sanity,
      trace: v1Response.trace,
      enqueued_at: new Date().toISOString(),
    });
  }

  const hasA = (result.trace.track_a?.annotated_candidates ?? []).some(
    (c) => c.fit === 'fits' || c.fit === 'partial',
  );
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
    finalCode: result.final_code,
    goodsDescriptionAr: result.goods_description_ar,
    sanityVerdict: result.sanity_verdict,
    hitl: result.hitl,
    v1: v1Response,
    trace: itemTrace,
  };
}
