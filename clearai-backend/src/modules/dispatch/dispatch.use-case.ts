/**
 * Dispatch — pipeline entry point.
 *
 * Wraps the 5-stage pipeline orchestrator and adapts its output to the
 * DispatchResult contract expected by declaration-sets/classification.service.ts.
 *
 * Tenant slug is resolved from CanonicalLineItem.clientId for multi-tenant
 * routing. Falls back to 'naqel' (the only active tenant) until the
 * tenant-resolution service is built.
 */
import { randomUUID } from 'node:crypto';
import { runPipeline } from '../pipeline/pipeline.orchestrator.js';
import type { CanonicalLineItem } from '../tenants/tenant-config.types.js';
import type { DispatchResult } from './dispatch.contract.js';

function resolveTenantSlug(_item: CanonicalLineItem): string {
  // TODO(multi-tenant): resolve from item.clientId via tenant registry.
  return 'naqel';
}

export async function dispatch(item: CanonicalLineItem): Promise<DispatchResult> {
  const itemId = randomUUID();
  const tenantSlug = resolveTenantSlug(item);

  const result = await runPipeline(item, tenantSlug, itemId);

  // Adapt PipelineTrace → ItemTrace (the existing contract shape).
  const itemTrace = {
    pathTaken: result.trace.signal_count,
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
