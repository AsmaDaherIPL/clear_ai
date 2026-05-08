/**
 * Dispatch — pipeline entry point.
 *
 * Wraps the 5-stage pipeline orchestrator and adapts its output to the
 * DispatchResult contract expected by declaration-runs/classification.service.ts.
 *
 * Tenant slug is resolved from CanonicalLineItem.clientId for multi-operator
 * routing. Falls back to 'naqel' (the only active operator) until the
 * operator-resolution service is built.
 */
import { randomUUID } from 'node:crypto';
import { runPipeline } from '../pipeline/pipeline.orchestrator.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { DispatchResult } from './dispatch.contract.js';

function resolveOperatorSlug(_item: CanonicalLineItem): string {
  // TODO(multi-operator): resolve from item.clientId via operator registry.
  return 'naqel';
}

export async function dispatch(item: CanonicalLineItem): Promise<DispatchResult> {
  const itemId = randomUUID();
  const operatorSlug = resolveOperatorSlug(item);

  const result = await runPipeline(item, operatorSlug, itemId);

  // Adapt PipelineTrace → ItemTrace (the existing contract shape).
  // pathTaken summarises which signals fired, derived from whether each
  // track produced a code. Used for the legacy ItemTrace contract only;
  // dispatch-v1 callers should look at description_classifier_chosen_code
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
