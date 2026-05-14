/**
 * Thin HTTP layer for declaration-run endpoints. Multipart parse + zod
 * validation + delegation to declaration-run.use-case. Maps errors to the
 * shared envelope.
 */
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { CreateBatchFieldsSchema, PatchBatchSchema } from './declaration-run.validation.js';
import { createBatch, runProcessing, type UploadKind } from './declaration-run.use-case.js';
import {
  cancelBatchIfActive,
  countItemsByStatus,
  getBatch,
} from './declaration-run.repository.js';
import { getPool } from '../../db/client.js';
import { enrichCodes } from '../reference-data/code-enrichment.service.js';
import { assembleCanonicalItem } from '../pipeline/trace/dispatch-v1.js';
import type {
  ClassificationStatus as VerdictClassificationStatus,
  SanityVerdict,
} from '../pipeline/shared/pipeline.types.js';
import {
  BatchValidationError,
  BatchTooLargeError,
  BatchNotFoundError,
} from './declaration-run.errors.js';
import { OperatorNotFoundError, RequiredFieldMissingError } from '../operators/operator.errors.js';
import { getOperatorById } from '../operators/operator.repository.js';
import type { BatchSummary } from './declaration-run.types.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';
import type {
  ClassificationStatus,
  DeclarationStatus,
  BatchMode,
  BatchStatus,
  BatchItemStatus,
} from '../../db/schema.js';

const VALID_ITEM_STATUSES: readonly BatchItemStatus[] = [
  'pending',
  'classifying',
  'succeeded',
  'flagged',
  'blocked',
  'pending_infra',
  'failed',
];

const ACCEPTED_EXTS: Record<string, UploadKind> = {
  csv: 'csv',
  xlsx: 'xlsx',
};

/**
 * Hardcoded single-operator slug for V1. The multipart body no longer
 * accepts operator_slug; the deployment is single-tenant and every
 * batch runs as 'naqel'. Mirrors the same constant in pipeline.routes.ts
 * for the single-shot dispatch path. When V2 multi-operator lands, both
 * sites switch back to reading from the request.
 */
const V1_OPERATOR_SLUG = 'naqel';

function sniffKindFromFilename(filename: string | undefined): UploadKind | null {
  if (!filename) return null;
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext || !(ext in ACCEPTED_EXTS)) return null;
  return ACCEPTED_EXTS[ext]!;
}

interface MultipartFields {
  file: MultipartFile | undefined;
  fields: Record<string, string>;
}

async function readMultipart(req: FastifyRequest): Promise<MultipartFields> {
  const fields: Record<string, string> = {};
  let file: MultipartFile | undefined;
  // Fastify-multipart's iterator yields parts in body order.
  // Files are streamed; we buffer the file before any per-row processing.
  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === 'file') {
      file = part;
      // CRITICAL: drain the file stream into a buffer NOW, before iteration
      // moves on to the next part. We retain the buffer on a synthetic
      // property so the caller can read it.
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk as Buffer);
      (file as MultipartFile & { _buffer: Buffer })._buffer = Buffer.concat(chunks);
    } else {
      const v = part as MultipartValue<string>;
      fields[v.fieldname] = String(v.value ?? '');
    }
  }
  return { file, fields };
}

export async function handleCreateBatch(
  req: FastifyRequest,
  reply: FastifyReply,
  dispatch: DispatchFn,
): Promise<unknown> {
  const { file, fields } = await readMultipart(req);

  if (!file) {
    throw new BatchValidationError('multipart upload missing the `file` part');
  }
  const kind = sniffKindFromFilename(file.filename);
  if (!kind) {
    throw new BatchValidationError(`unsupported file extension: ${file.filename}`);
  }

  // 2026-05-12 cutover: multipart body shrunk to `{file, mode}`. The
  // single-operator V1 deployment hardcodes operator_slug to 'naqel'.
  // callback_url + metadata channels were unused by any caller and were
  // dropped from the spec; the only metadata retained is the original
  // upload filename (handy for ops triage).
  const parsed = CreateBatchFieldsSchema.safeParse({
    mode: fields.mode || undefined,
  });
  if (!parsed.success) {
    throw new BatchValidationError('field validation failed', { issues: parsed.error.issues });
  }
  const body = parsed.data;

  const buf = (file as MultipartFile & { _buffer: Buffer })._buffer;

  const { declarationRun } = await createBatch({
    operatorSlug: V1_OPERATOR_SLUG,
    mode: body.mode as BatchMode,
    uploadKind: kind,
    uploadBytes: buf,
    metadata: { original_filename: file.filename },
    dispatch,
  });

  // Kick off processing in background; surface the id immediately.
  void runProcessing(declarationRun.id, dispatch).catch((err: unknown) => {
    req.log.error({ err, declaration_run_id: declarationRun.id }, 'background processing failed');
  });

  // Slim 202 response: just the batch id + mode. Clients construct
  // paths from the canonical URL pattern (`/batches/<id>/...`).
  return reply.code(202).send({
    batch_id: declarationRun.id,
    mode: declarationRun.mode,
  });
}

export async function handleGetBatch(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<unknown> {
  const declarationRun = await getBatch(req.params.id);
  const counts = await countItemsByStatus(declarationRun.id);
  const operator = await getOperatorById(declarationRun.operatorId);
  const summary: BatchSummary = {
    id: declarationRun.id,
    operator_slug: operator?.slug ?? '',
    mode: declarationRun.mode as BatchMode,
    status: declarationRun.status as BatchStatus,
    classification_status: declarationRun.classificationStatus as ClassificationStatus,
    declaration_status: (declarationRun.declarationStatus ?? null) as DeclarationStatus | null,
    row_count: declarationRun.rowCount,
    succeeded: counts.succeeded,
    flagged: counts.flagged,
    blocked: counts.blocked,
    failed: counts.failed,
    pending: counts.pending + counts.classifying,
    pending_infra: counts.pending_infra,
    started_at: declarationRun.startedAt?.toISOString() ?? null,
    completed_at: declarationRun.completedAt?.toISOString() ?? null,
    error: declarationRun.error,
  };
  return reply.send(summary);
}

export async function handleListClassifications(
  req: FastifyRequest<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; include_trace?: string; status?: string };
  }>,
  reply: FastifyReply,
): Promise<unknown> {
  const declarationRun = await getBatch(req.params.id);

  // Server-side pagination. Default page size is generous (100) so small
  // batches don't have to deal with the pagination protocol; SPA can ask
  // for up to 500 per page. Bounds enforced loudly via 400 — silent
  // clamping would mask bugs in the caller.
  const limitRaw = req.query.limit;
  const offsetRaw = req.query.offset;
  const limit = limitRaw === undefined ? 100 : Number(limitRaw);
  const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new BatchValidationError('limit must be an integer between 1 and 500', {
      received: limitRaw,
    });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new BatchValidationError('offset must be a non-negative integer', {
      received: offsetRaw,
    });
  }
  const includeTrace = req.query.include_trace === 'true' || req.query.include_trace === '1';

  const statusRaw = req.query.status;
  let statusFilter: BatchItemStatus[] | null = null;
  if (statusRaw !== undefined && statusRaw !== '') {
    const requested = statusRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const invalid = requested.filter(
      (s): s is string => !(VALID_ITEM_STATUSES as readonly string[]).includes(s),
    );
    if (invalid.length > 0) {
      throw new BatchValidationError(
        `status must be a comma-separated list of: ${VALID_ITEM_STATUSES.join(', ')}`,
        { received: statusRaw, invalid },
      );
    }
    statusFilter = requested as BatchItemStatus[];
  }

  // Returns whatever items are in flight RIGHT NOW so the SPA's
  // BatchResultsTable can paint rows progressively as Phase 1 completes
  // them. Frontend uses the top-level `classification_phase` flag below
  // to know when to stop polling.
  // Single query joins display so the result table can render the
  // bilingual catalog hierarchy + the LLM-generated Arabic submission
  // text per item without follow-up fetches. The heavy `i.trace` JSONB
  // is only selected when include_trace=true to keep paging cheap.
  const pool = getPool();
  const traceColumn = includeTrace ? 'i.trace' : 'NULL::jsonb';
  const statusClause = statusFilter ? 'AND i.status = ANY($4::text[])' : '';
  const listParams: unknown[] = [declarationRun.id, limit, offset];
  if (statusFilter) listParams.push(statusFilter);
  const r = await pool.query<{
    id: string;
    row_index: number;
    status: string;
    final_code: string | null;
    trace: unknown;
    error: string | null;
    catalog_path_en: string | null;
    catalog_path_ar: string | null;
    submission_description_ar: string | null;
    classification_status: string | null;
    sanity_verdict: string | null;
    raw_merchant_code: string | null;
    raw_description: string | null;
    retrieval_query: string | null;
    value_amount: string | null;
    currency_code: string | null;
    value_amount_sar: string | null;
    fx_rate: string | null;
    fx_rate_as_of: string | null;
    picker_confidence: string | null;
  }>(
    `SELECT i.id,
            i.row_index,
            i.status,
            i.final_code,
            ${traceColumn}              AS trace,
            i.error,
            d.path_en                   AS catalog_path_en,
            d.path_ar                   AS catalog_path_ar,
            i.goods_description_ar      AS submission_description_ar,
            (i.canonical ->> 'valueAmount')::numeric    AS value_amount,
            (i.canonical ->> 'currencyCode')            AS currency_code,
            (i.canonical ->> 'valueAmountSar')::numeric AS value_amount_sar,
            (i.canonical ->> 'fxRate')::numeric         AS fx_rate,
            (i.canonical ->> 'fxRateAsOf')              AS fx_rate_as_of,
            COALESCE(
              -- Legacy: verdict.classification_status / conflict_type
              i.trace -> 'meta' -> 'verdict' ->> 'classification_status',
              CASE i.trace -> 'meta' -> 'verdict' ->> 'conflict_type'
                WHEN 'AGREEMENT' THEN 'AGREEMENT'
                WHEN 'ZERO_SIGNAL' THEN 'ZERO_SIGNAL'
                WHEN 'DRIFT' THEN 'DRIFT'
                WHEN 'CONTRADICTION' THEN 'DRIFT'
                WHEN 'AMBIGUOUS_MATERIAL' THEN 'DRIFT'
                WHEN 'SPARSE_DESCRIPTION' THEN 'DRIFT'
                ELSE NULL
              END,
              -- Anchored (PR-A-5.1): mirror classificationStatusFromTrace
              -- in src/modules/pipeline/trace/dispatch-v1.ts. pick.escalate
              -- → ZERO_SIGNAL; pick.accepted + identify.clean_product +
              -- fit=fits → AGREEMENT; any other accepted shape → DRIFT.
              CASE
                WHEN (i.trace -> 'meta' -> 'anchored_pick' ->> 'kind') = 'escalate'
                  THEN 'ZERO_SIGNAL'
                WHEN (i.trace -> 'meta' -> 'anchored_pick' ->> 'kind') = 'accepted'
                  AND (i.trace -> 'meta' -> 'anchored_identify' ->> 'kind') = 'clean_product'
                  AND (i.trace -> 'meta' -> 'anchored_pick' ->> 'fit') = 'fits'
                  THEN 'AGREEMENT'
                WHEN (i.trace -> 'meta' -> 'anchored_pick' ->> 'kind') = 'accepted'
                  THEN 'DRIFT'
                ELSE NULL
              END
            )                                                       AS classification_status,
            (i.trace -> 'meta' -> 'sanity' ->> 'verdict')           AS sanity_verdict,
            -- raw_merchant_code: read directly from the canonical JSONB
            -- (the merchant-supplied verbatim digits). Architecture-
            -- agnostic; the legacy path via track_b.raw_merchant_code
            -- went stale under anchored where track_b is null. The
            -- canonical column has been the source of truth all along.
            (i.canonical ->> 'merchantHsCode')                      AS raw_merchant_code,
            (i.canonical ->> 'description')                         AS raw_description,
            -- retrieval_query: under legacy, track_a.effective_description;
            -- under anchored, identify.canonical when identify produced
            -- a clean_product. Mirrors retrievalQueryFromTrace in
            -- dispatch-v1.ts.
            COALESCE(
              i.trace -> 'meta' -> 'track_a' ->> 'effective_description',
              CASE
                WHEN (i.trace -> 'meta' -> 'anchored_identify' ->> 'kind') = 'clean_product'
                  THEN (i.trace -> 'meta' -> 'anchored_identify' ->> 'canonical')
                ELSE NULL
              END
            )                                                       AS retrieval_query,
            -- picker_confidence: legacy track_a.picker_confidence; anchored
            -- pick.confidence when pick accepted. Mirrors
            -- classificationConfidenceFromTrace in dispatch-v1.ts.
            COALESCE(
              i.trace -> 'meta' -> 'track_a' ->> 'picker_confidence',
              CASE
                WHEN (i.trace -> 'meta' -> 'anchored_pick' ->> 'kind') = 'accepted'
                  THEN (i.trace -> 'meta' -> 'anchored_pick' ->> 'confidence')
                ELSE NULL
              END
            )                                                       AS picker_confidence
       FROM declaration_run_items i
       LEFT JOIN zatca_hs_code_display d ON d.code = i.final_code
      WHERE i.declaration_run_id = $1
        ${statusClause}
      ORDER BY i.row_index
      LIMIT $2 OFFSET $3`,
    listParams,
  );
  // Run total in parallel for the response envelope. Re-running the
  // count on every poll tick is wasteful but tiny (it's just a COUNT(*)
  // on the indexed declaration_run_id); short-circuiting would require
  // caching and complicate the freshness story during live ingestion.
  const countParams: unknown[] = [declarationRun.id];
  if (statusFilter) countParams.push(statusFilter);
  const totalRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM declaration_run_items
      WHERE declaration_run_id = $1
        ${statusFilter ? 'AND status = ANY($2::text[])' : ''}`,
    countParams,
  );
  const total = Number(totalRes.rows[0]?.count ?? 0);
  const itemsFetchedSoFar = offset + r.rows.length;
  const hasMore = itemsFetchedSoFar < total;

  const enrichmentByCode = await enrichCodes(
    r.rows.map((i) => i.final_code),
    req.log,
  );

  const operator = await getOperatorById(declarationRun.operatorId);
  const operatorSlug = operator?.slug ?? '';

  return reply.send({
    // Envelope key renamed declaration_run_id → batch_id in the
    // 2026-05-12 API cutover. The DB column is still
    // declaration_run_items.declaration_run_id; only the wire-format
    // name changed.
    batch_id: declarationRun.id,
    operator_slug: operatorSlug,
    classification_phase: declarationRun.classificationStatus,
    total,
    limit,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? itemsFetchedSoFar : null,
    items: r.rows.map((i) => {
      const enrichment = i.final_code ? enrichmentByCode.get(i.final_code) : null;
      const valueAmount =
        i.value_amount_sar !== null
          ? Number(i.value_amount_sar)
          : i.value_amount !== null
            ? Number(i.value_amount)
            : null;
      const valueCurrency = i.value_amount_sar !== null ? 'SAR' : i.currency_code;
      return assembleCanonicalItem({
        id: i.id,
        rowIndex: i.row_index,
        declared: {
          hs_code: i.raw_merchant_code,
          description: i.raw_description,
          amount: i.value_amount !== null ? Number(i.value_amount) : null,
          currency: i.currency_code,
        },
        resolvedHsCode: i.final_code,
        catalogPathEn: i.catalog_path_en,
        catalogPathAr: i.catalog_path_ar,
        submissionDescriptionAr: i.submission_description_ar,
        submissionDescriptionEn: null,
        retrievalQuery: i.retrieval_query,
        valueSar: { amount: valueAmount, currency: valueCurrency },
        fxRate: i.fx_rate !== null ? Number(i.fx_rate) : null,
        fxRateAsOf: i.fx_rate_as_of,
        dutyInfo: enrichment?.duty_info ?? null,
        procedures: enrichment?.procedures ?? [],
        classificationStatus: (i.classification_status as VerdictClassificationStatus | null) ?? null,
        classificationConfidence: i.picker_confidence !== null ? Number(i.picker_confidence) : null,
        sanityVerdict: (i.sanity_verdict as SanityVerdict | null) ?? null,
        trace: includeTrace ? (i.trace as Record<string, unknown> | null) : null,
        error: i.error,
        includeTrace,
      });
    }),
  });
}

export async function handlePatchBatch(
  req: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<unknown> {
  const parsed = PatchBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BatchValidationError('only { status: "cancelled" } is permitted', { issues: parsed.error.issues });
  }
  const updated = await cancelBatchIfActive(req.params.id);
  return reply.send({ id: updated.id, status: updated.status });
}

export function mapDeclarationRunError(err: unknown): { statusCode: number; body: unknown } | null {
  if (err instanceof BatchValidationError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  if (err instanceof BatchTooLargeError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  if (err instanceof BatchNotFoundError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof OperatorNotFoundError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof RequiredFieldMissingError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  return null;
}

export async function attachDeclarationRunPlugins(app: FastifyInstance): Promise<void> {
  // Idempotent register guard via Symbol marker.
  const KEY = Symbol.for('clearai.multipart.registered');
  const flag = (app as unknown as Record<symbol, unknown>)[KEY];
  if (flag) return;
  const multipart = (await import('@fastify/multipart')).default;
  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024, // 25 MB cap.
      files: 1,
    },
  });
  (app as unknown as Record<symbol, unknown>)[KEY] = true;
}
