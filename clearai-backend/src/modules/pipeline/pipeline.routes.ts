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
  classificationConfidenceBandFromTrace,
  classificationStatusFromTrace,
  deriveClassificationStatus,
  retrievalQueryFromTrace,
} from './trace/dispatch-v1.js';
import { deriveConfidenceBand } from './v2/pick/pick.js';
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

// Accept any valid UUID (any version + variant). The classification_events
// table has historical UUIDv4 rows from before newId() switched to UUIDv7,
// so a strict UUIDv7 regex would 400 on lookups of those rows. Spec
// (and Fastify route type) keeps `format: uuid`.
const TraceIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    { message: 'id must be a UUID' },
  );

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

    // 2026-05-20: when the pipeline could not resolve a code AND the
    // failure was infra-side (Foundry transport timeout, embedder
    // failure, etc.), short-circuit with a flat error envelope and HTTP
    // 503 (Service Unavailable). Previously the API returned a
    // CanonicalItem with final_code=null and classification_status=
    // ZERO_SIGNAL — identical shape to "input had no signal" rows.
    // SPA couldn't tell the two apart. Now: transport failures bypass
    // the CanonicalItem entirely and the SPA gets a non-200 with a
    // structured error code it can branch on (retry CTA vs. HITL).
    if (result.infra_degraded && result.final_code === null) {
      let errorCode = 'infra_degraded';
      let errorMessage = 'upstream service unavailable, retry';
      const identifyTrace = result.trace.identify;
      if (
        identifyTrace.kind === 'uninformative' &&
        identifyTrace.cause === 'transport'
      ) {
        errorCode = 'identify_transport_failed';
        errorMessage = 'upstream LLM service unavailable, retry';
      } else if (
        result.trace.pick.kind === 'escalate' &&
        result.trace.pick.reason === 'picker_unavailable'
      ) {
        errorCode = 'pick_transport_failed';
        errorMessage = 'upstream LLM service unavailable, retry';
      }
      // Still write the classification_event row (durable audit trail —
      // we want a record that this row failed at infra, not silently
      // dropped). HITL enqueue is skipped because there's nothing for a
      // reviewer to act on; the row should be re-submitted once
      // upstream recovers.
      await recordClassificationEvent(
        {
          operatorId: operatorConfig.id,
          operatorSlug: V1_OPERATOR_SLUG,
          request: body,
          response: v1Response,
          totalLatencyMs: Date.now() - startedAtMs,
        },
        req.log,
      );
      return reply.code(503).send({
        error: {
          code: errorCode,
          message: errorMessage,
        },
      });
    }

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
      classificationConfidenceBand: classificationConfidenceBandFromTrace(result.trace),
      sanityVerdict: result.sanity_verdict ?? null,
      trace: v1Response.trace,
      error: null,
      includeTrace,
    });

    // 2026-05-19 (remediation plan §1.4.3 + TASKS D2): the
    // classification_events write was previously fire-and-forget
    // inside a `void (async () => ...)()` IIFE. If serialisation, pool
    // exhaustion, or a logger error fired, the canonical audit row
    // dropped silently — direct violation of
    // rule_classification_events_single_source.md.
    //
    // Now: await the write before responding 200. Adds ~50-150ms to
    // the response, which is acceptable for the audit-trail guarantee.
    // If latency hurts at scale, the next step is a durable outbox
    // table with a worker — out of scope for PR 1's "stop the bleeding"
    // pass. The HITL enqueue is also awaited for the same reason
    // (previously gated on the IIFE completing).
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
    } else if (
      eventOk &&
      !result.hitl &&
      classificationStatusFromTrace(result.trace) === 'AGREEMENT'
    ) {
      // PR6 / plan §1.1.2: random 5% AGREEMENT shadow sample. AGREEMENT
      // rows never reach HITL by design — but any future calibration
      // on HITL data is biased blind to high-confidence wrong picks.
      // Sample a slice of AGREEMENT rows uniformly so the calibration
      // set can see them. Production still ships the row (this enqueue
      // is purely an audit shadow).
      const rate = parseFloat(process.env.SHADOW_SAMPLE_RATE_PERCENT ?? '5') / 100;
      if (rate > 0 && Math.random() < rate) {
        const cleaned =
          result.trace.identify.kind === 'clean_product'
            ? result.trace.identify.canonical
            : item.description;
        await enqueueHitl(
          {
            classification_event_id: item.itemId,
            item_id: item.itemId,
            batch_id: null,
            operator_slug: V1_OPERATOR_SLUG,
            reason: 'shadow_sample',
            cleaned_description: cleaned,
            verdict_output: null,
            sanity_result: result.trace.sanity,
            trace: v1Response.trace,
            enqueued_at: new Date().toISOString(),
            shadow_sample: true,
          },
          req.log,
        );
      }
    }

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
      // Pipeline architecture is inferred from the wire summary so this
      // GET handler can render rows from any era (legacy + anchored
      // pre-PR 13, v2 from PR 13 onwards).
      const arch = trace?.summary?.pipeline_architecture ?? 'legacy';
      // Legacy fields: description_classifier + reconciliation actions.
      const dcAction = trace ? findActionInTrace(trace, 'description_classifier') : null;
      const dcOutput =
        (dcAction?.output as
          | { effective_description?: string; picker_confidence?: number | null }
          | undefined) ?? {};
      const submissionAction = trace ? findActionInTrace(trace, 'submission_description') : null;
      const submissionOutput = (submissionAction?.output as { description_ar?: string } | undefined) ?? {};
      const reconciliationAction = trace ? findActionInTrace(trace, 'reconciliation') : null;
      const reconciliationOutput = (reconciliationAction?.output as { classification_status?: ClassificationStatus } | undefined) ?? {};
      // v2 fields: identify + pick + verify actions. Mirrors
      // retrievalQueryFromTrace + classificationStatusFromTrace +
      // classificationConfidenceFromTrace in dispatch-v1.ts.
      const identifyAction = trace ? findActionInTrace(trace, 'identify') : null;
      const identifyOutput =
        (identifyAction?.output as
          | { kind?: string; canonical?: string }
          | undefined) ?? {};
      const pickAction = trace ? findActionInTrace(trace, 'pick') : null;
      const pickOutput =
        (pickAction?.output as
          | {
              kind?: string;
              confidence?: number;
              confidence_band?: string;
              fit?: string;
              reason?: string;
            }
          | undefined) ?? {};
      const v2RetrievalQuery =
        identifyOutput.kind === 'clean_product' ? identifyOutput.canonical ?? null : null;
      // PR5 / TASKS S1 #2 (L3): single canonical derivation. Previously
      // this site re-derived the status inline and was missing the
      // brand-rescue → DRIFT branch (rows with identify.confidence < 0.60
      // were labelled AGREEMENT here while the orchestrator labelled
      // them DRIFT — same row, different status depending on which
      // endpoint the SPA hit). Use deriveClassificationStatus with the
      // raw fields extracted from the stored JSONB trace.
      const verifyAction = trace ? findActionInTrace(trace, 'verify') : null;
      const verifyOutput =
        (verifyAction?.output as { result?: 'PASS' | 'UNCERTAIN' } | undefined) ?? {};
      const identifyConfidenceFromTrace =
        (identifyAction?.output as { confidence?: number } | undefined)?.confidence ?? null;
      const v2ClassificationStatus: ClassificationStatus | null =
        arch === 'v2' && trace
          ? deriveClassificationStatus({
              pickKind:
                pickOutput.kind === 'accepted' || pickOutput.kind === 'escalate'
                  ? pickOutput.kind
                  : null,
              pickReason:
                pickOutput.kind === 'escalate' &&
                (pickOutput.reason === 'scope_escalate' ||
                  pickOutput.reason === 'no_candidates' ||
                  pickOutput.reason === 'no_candidate_fits' ||
                  pickOutput.reason === 'identify_no_query' ||
                  pickOutput.reason === 'picker_unavailable')
                  ? pickOutput.reason
                  : null,
              pickFit:
                pickOutput.fit === 'fits' ||
                pickOutput.fit === 'partial' ||
                pickOutput.fit === 'does_not_fit'
                  ? pickOutput.fit
                  : null,
              pickConfidenceBand:
                pickOutput.confidence_band === 'high' ||
                pickOutput.confidence_band === 'moderate' ||
                pickOutput.confidence_band === 'fair' ||
                pickOutput.confidence_band === 'low' ||
                pickOutput.confidence_band === 'no_result'
                  ? pickOutput.confidence_band
                  : null,
              identifyKind:
                identifyOutput.kind === 'clean_product' ||
                identifyOutput.kind === 'multi_product' ||
                identifyOutput.kind === 'uninformative'
                  ? identifyOutput.kind
                  : null,
              identifyConfidence: identifyConfidenceFromTrace,
              verifyResult: verifyOutput.result ?? null,
            })
          : null;
      const v2PickerConfidence =
        pickOutput.kind === 'accepted' && typeof pickOutput.confidence === 'number'
          ? pickOutput.confidence
          : null;

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
        retrievalQuery: arch === 'v2'
          ? v2RetrievalQuery
          : (dcOutput.effective_description ?? null),
        valueSar: {
          amount: request.value_amount ?? null,
          currency: request.currency_code ?? null,
        },
        fxRate: null,
        fxRateAsOf: null,
        dutyInfo: enrichment.duty_info,
        procedures: enrichment.procedures,
        classificationStatus: arch === 'v2'
          ? v2ClassificationStatus
          : (reconciliationOutput.classification_status ?? null),
        classificationConfidence: arch === 'v2'
          ? v2PickerConfidence
          : (dcOutput.picker_confidence ?? null),
        classificationConfidenceBand: (() => {
          const c =
            arch === 'v2' ? v2PickerConfidence : (dcOutput.picker_confidence ?? null);
          // PR14: a stored picker_confidence means a code was accepted
          // and shipped; band floor clamps to 'low' (never 'no_result').
          return typeof c === 'number' ? deriveConfidenceBand(c, true) : null;
        })(),
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

  // -------------------------------------------------------------------
  // GET /classifications — slim list across all batches.
  //
  // Returns a paginated list of classification_events rows (one row per
  // classification, single-shot OR bulk item). Slim: no trace, no
  // request blob — those are heavyweight. Use GET /classifications/:id
  // for the full envelope with trace.
  //
  // Query params:
  //   limit          1..200, default 50
  //   offset         >= 0, default 0
  //   status         optional, comma-separated values (e.g. "ok,failed")
  //   operator_slug  optional, exact match
  //   final_code     optional, exact 12-digit match
  // -------------------------------------------------------------------
  const ListClassificationsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
    status: z.string().optional(),
    operator_slug: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/).optional(),
    final_code: z.string().regex(/^\d{12}$/).optional(),
  });

  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
      operator_slug?: string;
      final_code?: string;
    };
  }>('/classifications', async (req, reply) => {
    const parsed = ListClassificationsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_query',
          message: 'Query validation failed.',
          details: parsed.error.flatten(),
        },
      });
    }
    const { limit, offset, status, operator_slug, final_code } = parsed.data;

    const where: string[] = [];
    const args: unknown[] = [];
    if (status !== undefined && status !== '') {
      const list = status.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (list.length > 0) {
        args.push(list);
        where.push(`status = ANY($${args.length}::text[])`);
      }
    }
    if (operator_slug) {
      args.push(operator_slug);
      where.push(`operator_slug = $${args.length}`);
    }
    if (final_code) {
      args.push(final_code);
      where.push(`final_code = $${args.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const pool = getPool();
    args.push(limit);
    args.push(offset);

    const itemsRes = await pool.query<{
      id: string;
      created_at: string;
      operator_slug: string;
      status: string;
      final_code: string | null;
      sanity_verdict: string | null;
      total_latency_ms: number;
    }>(
      `SELECT id, created_at, operator_slug, status, final_code, sanity_verdict, total_latency_ms
         FROM classification_events
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );

    const totalRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM classification_events ${whereSql}`,
      args.slice(0, where.length),
    );
    const total = Number(totalRes.rows[0]?.count ?? 0);
    const fetched = offset + itemsRes.rows.length;
    const hasMore = fetched < total;

    return reply.code(200).send({
      items: itemsRes.rows,
      total,
      limit,
      offset,
      has_more: hasMore,
      next_offset: hasMore ? fetched : null,
    });
  });
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
