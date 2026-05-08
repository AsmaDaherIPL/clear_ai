/**
 * pipeline_events recorder.
 *
 * One INSERT per dispatch invocation. Best-effort: a recorder failure must
 * never break the dispatch response, so all errors are caught and logged.
 *
 * The full DispatchV1Trace lives in `trace` jsonb; the top-level columns
 * are denormalized facts you'll filter and aggregate on regularly.
 */
import { getPool } from '../../../db/client.js';
import { redactRequestBody } from '../../../common/logging/redact.js';
import type {
  DispatchV1Response,
  DispatchV1Stage,
  DispatchV1Action,
  TrackBResolution,
} from '../shared/pipeline.types.js';

export interface RecordPipelineEventInput {
  operatorId: string | null;
  operatorSlug: string;
  request: unknown;
  response: DispatchV1Response;
  totalLatencyMs: number;
}

interface PipelineEventLogger {
  error(obj: unknown, msg?: string): void;
}

export async function recordPipelineEvent(
  input: RecordPipelineEventInput,
  logger?: PipelineEventLogger,
): Promise<void> {
  const pool = getPool();
  const { response, request } = input;
  const trace = response.trace;

  const classifyStage = findStage(trace.stages, 'classify');
  const dcAction = classifyStage ? findAction(classifyStage, 'description_classifier') : null;
  const crAction = classifyStage ? findAction(classifyStage, 'code_resolver') : null;

  const dcOutput = (dcAction?.output as Record<string, unknown> | undefined) ?? {};
  const crOutput = (crAction?.output as Record<string, unknown> | undefined) ?? {};

  const descriptionClassifierChosenCode =
    typeof dcOutput.chosen_code === 'string' ? dcOutput.chosen_code : null;
  const descriptionClassifierConfidence =
    typeof dcOutput.confidence === 'number' ? dcOutput.confidence : null;

  const codeResolverResolvedCode =
    typeof crOutput.resolved_code === 'string' ? crOutput.resolved_code : null;
  const codeResolverResolution =
    typeof crOutput.resolution === 'string' ? (crOutput.resolution as TrackBResolution) : null;
  const codeResolverPath = mapResolverPath(codeResolverResolution);
  const tenantOverrideApplied = codeResolverResolution === 'tenant_override';

  const redactedRequest = redactRequestBody(request) ?? null;

  try {
    await pool.query(
      `INSERT INTO pipeline_events (
        id, operator_id, operator_slug,
        status, final_code, sanity_verdict,
        description_classifier_chosen_code, description_classifier_confidence,
        code_resolver_resolved_code, code_resolver_path, tenant_override_applied,
        total_latency_ms, request, trace
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8,
        $9, $10, $11,
        $12, $13, $14
      )`,
      [
        response.item_id,
        input.operatorId,
        input.operatorSlug,
        response.status,
        response.final_code,
        response.sanity_verdict,
        descriptionClassifierChosenCode,
        descriptionClassifierConfidence,
        codeResolverResolvedCode,
        codeResolverPath,
        tenantOverrideApplied,
        input.totalLatencyMs,
        redactedRequest === null ? null : JSON.stringify(redactedRequest),
        JSON.stringify(trace),
      ],
    );
  } catch (err) {
    if (logger) {
      logger.error({ err, item_id: response.item_id }, '[pipeline_events] insert failed');
    } else {
      // eslint-disable-next-line no-console
      console.error('[pipeline_events] insert failed:', err);
    }
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
    case 'tenant_override':
      return 'tenant_override';
    case 'null_resolution':
      return 'null_resolution';
    default:
      return null;
  }
}
