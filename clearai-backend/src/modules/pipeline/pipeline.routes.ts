/**
 * Pipeline single-shot HTTP surface.
 *
 *   POST /pipeline/dispatch     run the full pipeline on a single item
 *   GET  /pipeline/trace/:id    fetch a stored PipelineTrace for a run-item id
 *
 * The bulk path is /declaration-runs (multipart upload, background processing).
 * This route is for the SPA's single-item UX where the user types a
 * description, optionally pairs it with a merchant HS code, and gets one
 * classification + Arabic submission text back.
 *
 * Trace storage:
 *   /pipeline/dispatch returns the trace inline. There is no per-call
 *   server-side persistence (saves an INSERT on the hot path; the SPA can
 *   stash the trace client-side). For bulk runs, traces are persisted in
 *   declaration_run_items.trace and /pipeline/trace/:id reads them back.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { runPipeline } from './pipeline.orchestrator.js';
import { assembleDispatchV1 } from './trace/dispatch-v1.js';
import { recordClassificationEvent } from './events/recorder.js';
import { enqueueHitl } from './hitl/hitl.js';
import { getPool } from '../../db/client.js';
import { resolve as resolveOperator } from '../operators/operator-config.registry.js';
import { OperatorNotFoundError } from '../operators/operator.errors.js';
import { isBreakerTripped, breakerStatus } from '../../inference/llm/breaker.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { PipelineResult } from './shared/pipeline.types.js';

// ---------------------------------------------------------------------------
// POST /pipeline/dispatch
// ---------------------------------------------------------------------------

const DispatchBody = z.object({
  description: z.string().min(1).max(2000),
  merchant_code: z.string().optional(),
  /** Optional override; defaults to 'naqel' (the only seeded operator today). */
  operator_slug: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,31}$/)
    .optional()
    .default('naqel'),
  /** Optional commercial context — passed through to Stage 3 sanity. */
  value_amount: z.number().positive().optional(),
  currency_code: z.string().length(3).optional(),
});

type DispatchBody = z.infer<typeof DispatchBody>;

/**
 * Build a CanonicalLineItem from the slim dispatch body. Fields not provided
 * by the caller get safe placeholders — they're not consumed by the
 * classification pipeline (only by Phase 2 declaration generation, which
 * single-shot dispatch never runs).
 */
function buildItem(body: DispatchBody, operatorId: string): CanonicalLineItem {
  return {
    itemId: randomUUID(),
    rowIndex: 0,
    operatorId,
    operatorSlug: body.operator_slug,
    description: body.description,
    waybillNo: '',
    merchantHsCode: body.merchant_code ?? null,
    merchantSku: null,
    valueAmount: body.value_amount ?? 0,
    currencyCode: body.currency_code ?? 'SAR',
    quantity: 1,
    uom: 'PCE',
    netWeightKg: 0,
    consigneeAddress: null,
    clientId: '',
    countryOfOrigin: '',
    destinationStationId: '',
    consigneeName: '',
    consigneeNationalId: '',
    consigneePhone: '',
    invoiceDate: null,
  };
}

// ---------------------------------------------------------------------------
// GET /pipeline/trace/:id
// ---------------------------------------------------------------------------

const TraceIdSchema = z.string().uuid();

interface ClassificationEventTraceRow {
  id: string;
  operator_slug: string;
  status: string;
  final_code: string | null;
  trace: unknown;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // POST /pipeline/dispatch
  app.post('/pipeline/dispatch', async (req, reply) => {
    const parsed = DispatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Body validation failed.', details: parsed.error.flatten() },
      });
    }
    const body = parsed.data;

    // Refuse to start a classification when the LLM circuit breaker is tripped.
    // Sustained auth-class failures (401/403/404) mean the env is broken — every
    // call would silently produce a low-confidence override-passthrough or
    // escalate, which is data corruption with a clean-looking trace. Surface
    // 503 so the caller (SPA, infra agent, monitoring) sees the real reason.
    if (isBreakerTripped()) {
      const status = breakerStatus();
      return reply.code(503).send({
        error: {
          code: 'llm_unavailable',
          message: 'LLM circuit breaker tripped after sustained auth-class failures. Classification refused.',
          tripped_at_ms: status.tripped_at_ms,
          last_error: status.last_error,
        },
      });
    }

    let operatorConfig;
    try {
      operatorConfig = await resolveOperator(body.operator_slug);
    } catch (err) {
      if (err instanceof OperatorNotFoundError) {
        return reply.code(404).send({
          error: { code: 'operator_not_found', message: err.message },
        });
      }
      throw err;
    }

    const item = buildItem(body, operatorConfig.id);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const result: PipelineResult = await runPipeline(item, body.operator_slug, item.itemId);
    const completedAt = new Date().toISOString();

    const response = assembleDispatchV1({
      itemId: item.itemId,
      operatorSlug: body.operator_slug,
      result,
      startedAt,
      completedAt,
    });

    // Persist audit row first; if it succeeds and the orchestrator
    // surfaced a HITL intent, follow with the queue write so the FK
    // from hitl_queue.classification_event_id is satisfied. Both writes
    // are best-effort — failures are logged but never block the
    // response that's about to be sent.
    void (async () => {
      const eventOk = await recordClassificationEvent(
        {
          operatorId: operatorConfig.id,
          operatorSlug: body.operator_slug,
          request: body,
          response,
          totalLatencyMs: Date.now() - startedAtMs,
        },
        req.log,
      );

      if (eventOk && result.hitl) {
        await enqueueHitl(
          {
            classification_event_id: response.item_id,
            item_id: response.item_id,
            operator_slug: body.operator_slug,
            reason: result.hitl.reason,
            cleaned_description: result.hitl.cleaned_description,
            verdict_output: result.trace.verdict,
            sanity_result: result.trace.sanity,
            trace: response.trace,
            enqueued_at: new Date().toISOString(),
          },
          req.log,
        );
      }
    })();

    return reply.code(200).send(response);
  });

  // GET /pipeline/trace/:id
  //
  // classification_events is the single source of truth for traces —
  // every classification (one-off /pipeline/dispatch and per-item batch
  // processing) writes here via recordClassificationEvent. The id used
  // is canonical: it's the same UUID that flows through
  // declaration_run_items.id and the dispatch response's item_id.
  app.get<{ Params: { id: string } }>('/pipeline/trace/:id', async (req, reply) => {
    const idParse = TraceIdSchema.safeParse(req.params.id);
    if (!idParse.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUID.' },
      });
    }
    const id = idParse.data;

    const pool = getPool();
    const r = await pool.query<ClassificationEventTraceRow>(
      `SELECT id, operator_slug, status, final_code, trace, created_at
         FROM classification_events
        WHERE id = $1
        LIMIT 1`,
      [id],
    );
    if (r.rowCount === 0 || !r.rows[0]) {
      return reply.code(404).send({
        error: { code: 'trace_not_found', message: `No classification event for id ${id}.` },
      });
    }
    const row = r.rows[0];
    return reply.code(200).send({
      item_id: row.id,
      operator_slug: row.operator_slug,
      status: row.status,
      final_code: row.final_code,
      created_at: row.created_at.toISOString(),
      trace: row.trace,
    });
  });
}
