/**
 * Best-effort INSERT into classification_events. Returns true on success
 * so the dispatch route can sequence the dependent hitl_queue write
 * (the queue's FK references this row).
 */
import { getPool } from '../../../db/client.js';
import { redactRequestBody } from '../../../common/logging/redact.js';
import type {
  DispatchV1Response,
  DispatchV1Stage,
  DispatchV1Action,
  TrackBResolution,
} from '../shared/pipeline.types.js';

export interface RecordClassificationEventInput {
  operatorId: string | null;
  operatorSlug: string;
  request: unknown;
  response: DispatchV1Response;
  totalLatencyMs: number;
}

interface PipelineEventLogger {
  error(obj: unknown, msg?: string): void;
}

export async function recordClassificationEvent(
  input: RecordClassificationEventInput,
  logger?: PipelineEventLogger,
): Promise<boolean> {
  const pool = getPool();
  const { response, request } = input;
  const trace = response.trace;

  const classifyStage = findStage(trace.stages, 'classify');
  // Legacy + anchored fields. Under v2 these actions don't appear so
  // the values stay null and tenant_override_applied falls back to the
  // v2 merchant_resolution branch below.
  const dcAction = classifyStage ? findAction(classifyStage, 'description_classifier') : null;
  const crAction = classifyStage ? findAction(classifyStage, 'code_resolver') : null;
  const mrAction = classifyStage ? findAction(classifyStage, 'merchant_resolution') : null;

  const dcOutput = (dcAction?.output as Record<string, unknown> | undefined) ?? {};
  const crOutput = (crAction?.output as Record<string, unknown> | undefined) ?? {};
  const mrOutput = (mrAction?.output as Record<string, unknown> | undefined) ?? {};

  const annotatedCandidates = Array.isArray(dcOutput.annotated_candidates)
    ? (dcOutput.annotated_candidates as Array<{ code?: unknown; fit?: unknown }>)
    : [];
  const descriptionClassifierTopFitCode =
    annotatedCandidates.find((c) => c.fit === 'fits')?.code ?? null;
  const topFitCode = typeof descriptionClassifierTopFitCode === 'string'
    ? descriptionClassifierTopFitCode
    : null;

  // code_resolver_resolved_code: legacy code_resolver action under legacy,
  // merchant_resolution.resolved_code under v2.
  const codeResolverResolvedCode =
    typeof crOutput.resolved_code === 'string' ? crOutput.resolved_code
    : typeof mrOutput.resolved_code === 'string' ? mrOutput.resolved_code
    : null;
  const codeResolverResolution =
    typeof crOutput.resolution === 'string' ? (crOutput.resolution as TrackBResolution) : null;
  const codeResolverPath = mapResolverPath(codeResolverResolution);
  // tenant_override_applied: legacy code_resolver.override_applied OR v2
  // merchant_resolution.override_matched (both are booleans). Either
  // path lights the audit flag in the events table.
  const tenantOverrideApplied =
    crOutput.override_applied === true || mrOutput.override_matched === true;

  const redactedRequest = redactRequestBody(request) ?? null;

  try {
    await pool.query(
      `INSERT INTO classification_events (
        id, operator_id, operator_slug,
        status, final_code, sanity_verdict,
        description_classifier_top_fit_code,
        code_resolver_resolved_code, code_resolver_path, tenant_override_applied,
        total_latency_ms, request, trace
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7,
        $8, $9, $10,
        $11, $12, $13
      )`,
      [
        response.item_id,
        input.operatorId,
        input.operatorSlug,
        response.status,
        response.final_code,
        response.sanity_verdict,
        topFitCode,
        codeResolverResolvedCode,
        codeResolverPath,
        tenantOverrideApplied,
        input.totalLatencyMs,
        redactedRequest === null ? null : JSON.stringify(redactedRequest),
        JSON.stringify(trace),
      ],
    );
    return true;
  } catch (err) {
    if (logger) {
      logger.error({ err, item_id: response.item_id }, '[classification_events] insert failed');
    } else {
      // eslint-disable-next-line no-console
      console.error('[classification_events] insert failed:', err);
    }
    return false;
  }
}

function findStage(stages: DispatchV1Stage[], name: string): DispatchV1Stage | null {
  return stages.find((s) => s.stage === name) ?? null;
}

function findAction(stage: DispatchV1Stage, name: string): DispatchV1Action | null {
  return stage.actions.find((a) => a.action === name) ?? null;
}

function mapResolverPath(resolution: TrackBResolution | null): string | null {
  switch (resolution) {
    case 'passthrough':
      return 'deterministic_passthrough';
    case 'deterministic_swap':
      return 'deterministic_swap';
    case 'llm_pick_among_replacements':
      return 'llm_pick_among_replacements';
    case 'llm_pick_under_prefix':
      return 'llm_pick_under_prefix';
    case 'null_resolution':
      return 'null_resolution';
    default:
      return null;
  }
}
