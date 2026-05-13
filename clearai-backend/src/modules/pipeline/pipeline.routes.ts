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
import { stampFxFields, FxRateMissingError } from './parse/enrich-fx.js';
import {
  assembleCanonicalItem,
  assembleDispatchV1,
  classificationStatusFromTrace,
  retrievalQueryFromTrace,
} from './trace/dispatch-v1.js';
import { recordClassificationEvent } from './events/recorder.js';
import { enqueueHitl } from './review/review.js';
import { enrichCode, lookupCatalogPath } from '../reference-data/code-enrichment.service.js';
import { getPool } from '../../db/client.js';
import { resolve as resolveOperator } from '../operators/operator-config.registry.js';
import { OperatorNotFoundError } from '../operators/operator.errors.js';
import { isBreakerTripped, breakerStatus } from '../../inference/llm/breaker.js';
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { PipelineResult } from './shared/pipeline.types.js';

// ---------------------------------------------------------------------------
// POST /pipeline/dispatch
// ---------------------------------------------------------------------------

// Single-shot dispatch body. Tightened in the 2026-05-12 API cutover:
//   - description: max 500 (was 2000) to match the batch CSV row limit
//   - merchant_code: regex /^\d{6,12}$/ (was: any string)
//   - value_amount + currency_code: now REQUIRED (were optional)
//   - currency_code: regex /^[A-Z]{3}$/ ISO 4217 (was: just .length(3))
//   - operator_slug: removed entirely (single-operator V1; server uses 'naqel')
const DispatchBody = z.object({
  description: z.string().min(1).max(500),
  merchant_code: z
    .string()
    .regex(/^\d{6,12}$/, 'merchant_code must be 6-12 digits')
    .optional(),
  value_amount: z.number().positive(),
  currency_code: z.string().regex(/^[A-Z]{3}$/, 'currency_code must be a 3-letter ISO 4217 code'),
});

type DispatchBody = z.infer<typeof DispatchBody>;

/**
 * Hardcoded single-operator slug for V1. The dispatch body no longer
 * accepts operator_slug as a parameter — the deployment is single-tenant
 * and every classification runs as 'naqel'. When V2 multi-operator
 * lands, this becomes a request field again.
 */
const V1_OPERATOR_SLUG = 'naqel';

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
    operatorSlug: V1_OPERATOR_SLUG,
    description: body.description,
    waybillNo: '',
    merchantHsCode: body.merchant_code ?? null,
    merchantSku: null,
    valueAmount: body.value_amount,
    currencyCode: body.currency_code,
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

// UUIDv7 strict. Tighter than z.string().uuid() (which accepts v1/v4 too).
// All our ids are minted v7 via newId(), so anything else is malformed.
const TraceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
    message: 'id must be a UUIDv7',
  });

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
  app.post<{ Querystring: { include_trace?: string } }>('/classifications/dispatch', async (req, reply) => {
    const parsed = DispatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Body validation failed.', details: parsed.error.flatten() },
      });
    }
    const body = parsed.data;
    const includeTrace = req.query.include_trace === 'true' || req.query.include_trace === '1';

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
      operatorConfig = await resolveOperator(V1_OPERATOR_SLUG);
    } catch (err) {
      if (err instanceof OperatorNotFoundError) {
        return reply.code(404).send({
          error: { code: 'operator_not_found', message: err.message },
        });
      }
      throw err;
    }

    let item: CanonicalLineItem;
    try {
      item = await stampFxFields(buildItem(body, operatorConfig.id));
    } catch (err) {
      if (err instanceof FxRateMissingError) {
        return reply.code(400).send({
          error: {
            code: 'fx_rate_missing',
            message: err.message,
            currency: err.currency,
            as_of: err.asOfDate,
          },
        });
      }
      throw err;
    }
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const result: PipelineResult = await runPipeline(item, V1_OPERATOR_SLUG, item.itemId);
    const completedAt = new Date().toISOString();

    const v1Response = assembleDispatchV1({
      itemId: item.itemId,
      operatorSlug: V1_OPERATOR_SLUG,
      result,
      startedAt,
      completedAt,
    });

    const enrichment = await enrichCode(result.final_code, req.log);
    const catalogPath = await lookupCatalogPath(result.final_code);

    const canonical = assembleCanonicalItem({
      id: item.itemId,
      operatorSlug: V1_OPERATOR_SLUG,
      declared: {
        hs_code: body.merchant_code ?? null,
        description: body.description,
        amount: body.value_amount,
        currency: body.currency_code,
      },
      resolvedHsCode: result.final_code,
      catalogPathEn: catalogPath.path_en,
      catalogPathAr: catalogPath.path_ar,
      submissionDescriptionAr: result.goods_description_ar,
      submissionDescriptionEn: null,
      retrievalQuery: retrievalQueryFromTrace(result.trace),
      valueSar: {
        amount: item.valueAmountSar ?? body.value_amount,
        currency: item.valueAmountSar !== undefined ? 'SAR' : body.currency_code,
      },
      fxRate: item.fxRate ?? null,
      fxRateAsOf: item.fxRateAsOf ?? null,
      dutyInfo: enrichment.duty_info,
      procedures: enrichment.procedures,
      classificationStatus: classificationStatusFromTrace(result.trace),
      classificationConfidence: null,
      sanityVerdict: result.sanity_verdict,
      trace: v1Response.trace,
      error: null,
      includeTrace,
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
          operatorSlug: V1_OPERATOR_SLUG,
          request: body,
          response: v1Response,
          totalLatencyMs: Date.now() - startedAtMs,
        },
        req.log,
      );

      if (eventOk && result.hitl) {
        await enqueueHitl(
          {
            classification_event_id: item.itemId,
            item_id: item.itemId,
            // Single-shot dispatch has no parent batch.
            batch_id: null,
            operator_slug: V1_OPERATOR_SLUG,
            reason: result.hitl.reason,
            cleaned_description: result.hitl.cleaned_description,
            verdict_output: result.trace.verdict,
            sanity_result: result.trace.sanity,
            trace: v1Response.trace,
            enqueued_at: new Date().toISOString(),
          },
          req.log,
        );
      }
    })();

    return reply.code(200).send(canonical);
  });

  // GET /pipeline/trace/:id
  //
  // classification_events is the single source of truth for traces —
  // every classification (one-off /pipeline/dispatch and per-item batch
  // processing) writes here via recordClassificationEvent. The id used
  // is canonical: it's the same UUID that flows through
  // declaration_run_items.id and the dispatch response's item_id.
  app.get<{ Params: { id: string } }>('/classifications/trace/:id', async (req, reply) => {
    const idParse = TraceIdSchema.safeParse(req.params.id);
    if (!idParse.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUID.' },
      });
    }
    const id = idParse.data;

    const pool = getPool();
    const r = await pool.query<ClassificationEventTraceRow & { request: unknown }>(
      `SELECT id, operator_slug, status, final_code, trace, request, created_at
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
    const enrichment = await enrichCode(row.final_code, req.log);
    const request = (row.request as { value_amount?: number; currency_code?: string } | null) ?? {};
    return reply.code(200).send({
      item_id: row.id,
      operator_slug: row.operator_slug,
      status: row.status,
      final_code: row.final_code,
      created_at: row.created_at.toISOString(),
      value_amount: request.value_amount ?? null,
      currency_code: request.currency_code ?? null,
      duty_info: enrichment.duty_info,
      procedures: enrichment.procedures,
      trace: row.trace,
    });
  });
}
