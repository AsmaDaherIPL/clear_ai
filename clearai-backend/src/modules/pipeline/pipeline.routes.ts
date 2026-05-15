/**
 * Pipeline single-shot HTTP surface.
 *
 *   POST /classifications/dispatch     run the full pipeline on a single item
 *   GET  /classifications/:id          fetch a stored classification by item id
 *
 * The bulk path is /declaration-runs (multipart upload, background processing).
 * This route is for the SPA's single-item UX where the user types a
 * description, optionally pairs it with a merchant HS code, and gets one
 * classification + Arabic submission text back.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { runPipeline } from './orchestrator.js';
import { stampFxFields, FxRateMissingError } from './parse/enrich-fx.js';
import {
  assembleCanonicalItem,
  assembleDispatchV1,
  classificationConfidenceFromTrace,
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
import type {
  DispatchV1Response,
  DispatchV1Action,
  SanityVerdict,
  ClassificationStatus,
} from './shared/pipeline.types.js';

// ---------------------------------------------------------------------------
// POST /classifications/dispatch
// ---------------------------------------------------------------------------

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
 * Hardcoded single-operator slug for V1. When V2 multi-operator lands,
 * this becomes a request field.
 */
const V1_OPERATOR_SLUG = 'naqel';

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
// GET /classifications/:id
// ---------------------------------------------------------------------------

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
  sanity_verdict: string | null;
  trace: unknown;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // POST /classifications/dispatch
  app.post<{
    Querystring: { include_trace?: string };
  }>('/classifications/dispatch', async (req, reply) => {
    const parsed = DispatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Body validation failed.', details: parsed.error.flatten() },
      });
    }
    const body = parsed.data;
    const includeTrace = req.query.include_trace === 'true' || req.query.include_trace === '1';

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
    const result = await runPipeline(item, V1_OPERATOR_SLUG, item.itemId);
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
      classificationConfidence: classificationConfidenceFromTrace(result.trace),
      sanityVerdict: result.sanity_verdict ?? null,
      trace: v1Response.trace,
      error: null,
      includeTrace,
    });

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
            batch_id: null,
            operator_slug: V1_OPERATOR_SLUG,
            reason: result.hitl.reason,
            cleaned_description: result.hitl.cleaned_description,
            verdict_output: null,
            sanity_result: result.trace.sanity,
            trace: v1Response.trace,
            enqueued_at: new Date().toISOString(),
          },
          req.log,
        );
      }
    })();

    return reply.code(200).send({
      operator_slug: V1_OPERATOR_SLUG,
      item: canonical,
    });
  });

  // GET /classifications/:id?include_trace=true
  app.get<{ Params: { id: string }; Querystring: { include_trace?: string } }>(
    '/classifications/:id',
    async (req, reply) => {
      const idParse = TraceIdSchema.safeParse(req.params.id);
      if (!idParse.success) {
        return reply.code(400).send({
          error: { code: 'invalid_id', message: 'id must be a UUID.' },
        });
      }
      const id = idParse.data;
      const includeTrace = req.query.include_trace === 'true';

      const pool = getPool();
      const r = await pool.query<ClassificationEventTraceRow & { request: unknown }>(
        `SELECT id, operator_slug, status, final_code, sanity_verdict, trace, request, created_at
           FROM classification_events
          WHERE id = $1
          LIMIT 1`,
        [id],
      );
      if (r.rowCount === 0 || !r.rows[0]) {
        return reply.code(404).send({
          error: { code: 'classification_not_found', message: `No classification for id ${id}.` },
        });
      }
      const row = r.rows[0];
      const enrichment = await enrichCode(row.final_code, req.log);
      const catalogPath = row.final_code
        ? await lookupCatalogPath(row.final_code)
        : { path_en: null, path_ar: null };

      const request = (row.request as {
        value_amount?: number;
        currency_code?: string;
        description?: string;
        merchant_code?: string;
      } | null) ?? {};

      const trace = row.trace as DispatchV1Response['trace'] | null;
      const dcAction = trace ? findActionInTrace(trace, 'description_classifier') : null;
      const dcOutput =
        (dcAction?.output as
          | { effective_description?: string; picker_confidence?: number | null }
          | undefined) ?? {};
      const submissionAction = trace ? findActionInTrace(trace, 'submission_description') : null;
      const submissionOutput = (submissionAction?.output as { description_ar?: string } | undefined) ?? {};
      const reconciliationAction = trace ? findActionInTrace(trace, 'reconciliation') : null;
      const reconciliationOutput = (reconciliationAction?.output as { classification_status?: ClassificationStatus } | undefined) ?? {};

      const canonical = assembleCanonicalItem({
        id: row.id,
        declared: {
          hs_code: request.merchant_code ?? null,
          description: request.description ?? null,
          amount: request.value_amount ?? null,
          currency: request.currency_code ?? null,
        },
        resolvedHsCode: row.final_code,
        catalogPathEn: catalogPath.path_en,
        catalogPathAr: catalogPath.path_ar,
        submissionDescriptionAr: submissionOutput.description_ar ?? null,
        submissionDescriptionEn: null,
        retrievalQuery: dcOutput.effective_description ?? null,
        valueSar: {
          amount: request.value_amount ?? null,
          currency: request.currency_code ?? null,
        },
        fxRate: null,
        fxRateAsOf: null,
        dutyInfo: enrichment.duty_info,
        procedures: enrichment.procedures,
        classificationStatus: reconciliationOutput.classification_status ?? null,
        classificationConfidence: dcOutput.picker_confidence ?? null,
        sanityVerdict: (row.sanity_verdict as SanityVerdict | null) ?? null,
        trace: includeTrace ? (trace as Record<string, unknown> | null) : null,
        error: null,
        includeTrace,
      });

      return reply.code(200).send({
        operator_slug: row.operator_slug,
        item: canonical,
      });
    },
  );
}

function findActionInTrace(
  trace: DispatchV1Response['trace'],
  actionName: string,
): DispatchV1Action | null {
  for (const stage of trace.stages ?? []) {
    for (const action of stage.actions ?? []) {
      if (action.action === actionName) return action;
    }
  }
  return null;
}
