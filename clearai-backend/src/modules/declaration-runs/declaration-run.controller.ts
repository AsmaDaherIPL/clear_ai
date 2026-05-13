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
} from '../../db/schema.js';

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
    started_at: declarationRun.startedAt?.toISOString() ?? null,
    completed_at: declarationRun.completedAt?.toISOString() ?? null,
    error: declarationRun.error,
  };
  return reply.send(summary);
}

export async function handleListClassifications(
  req: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>,
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

  // Returns whatever items are in flight RIGHT NOW so the SPA's
  // BatchResultsTable can paint rows progressively as Phase 1 completes
  // them. The original 425 'phase_not_ready' guard was lifted 2026-05-10
  // when live polling went live — refusing service while items existed
  // forced the table to do one big drop at the end. Frontend uses the
  // top-level `classification_phase` flag below to know when to stop
  // polling.
  // Single query joins display + submission_descriptions so the SPA
  // result table can render `path_en` and the LLM-generated Arabic
  // submission text per item without follow-up fetches.
  const pool = getPool();
  // Top-level extracts let the SPA render the result table without
  // traversing the heavy `trace` JSONB on every row. raw_merchant_code,
  // codebook_state, override_applied feed the merchant→resolved diff
  // and the "Valid"/"Override applied" pill in BatchResultsTable.
  const r = await pool.query<{
    id: string;
    row_index: number;
    status: string;
    final_code: string | null;
    classification_result: unknown;
    trace: unknown;
    error: string | null;
    catalog_path_en: string | null;
    submission_description_ar: string | null;
    classification_status: string | null;
    raw_merchant_code: string | null;
    codebook_state: string | null;
    override_applied: boolean | null;
    raw_description: string | null;
    effective_description: string | null;
    value_amount: string | null;
    currency_code: string | null;
    value_amount_sar: string | null;
    fx_rate: string | null;
    fx_rate_as_of: string | null;
  }>(
    `SELECT i.id,
            i.row_index,
            i.status,
            i.final_code,
            i.classification_result,
            i.trace,
            i.error,
            d.path_en              AS catalog_path_en,
            i.goods_description_ar AS submission_description_ar,
            (i.canonical ->> 'valueAmount')::numeric    AS value_amount,
            (i.canonical ->> 'currencyCode')            AS currency_code,
            (i.canonical ->> 'valueAmountSar')::numeric AS value_amount_sar,
            (i.canonical ->> 'fxRate')::numeric         AS fx_rate,
            (i.canonical ->> 'fxRateAsOf')              AS fx_rate_as_of,
            -- V1 surface: AGREEMENT | DRIFT | ZERO_SIGNAL. Falls back to
            -- the legacy conflict_type mapping for older rows persisted
            -- before classification_status existed in the trace.
            COALESCE(
              i.trace -> 'meta' -> 'verdict' ->> 'classification_status',
              CASE i.trace -> 'meta' -> 'verdict' ->> 'conflict_type'
                WHEN 'AGREEMENT' THEN 'AGREEMENT'
                WHEN 'ZERO_SIGNAL' THEN 'ZERO_SIGNAL'
                WHEN 'DRIFT' THEN 'DRIFT'
                WHEN 'CONTRADICTION' THEN 'DRIFT'
                WHEN 'AMBIGUOUS_MATERIAL' THEN 'DRIFT'
                WHEN 'SPARSE_DESCRIPTION' THEN 'DRIFT'
                ELSE NULL
              END
            )                                                          AS classification_status,
            (i.trace -> 'meta' -> 'track_b' ->> 'raw_merchant_code')  AS raw_merchant_code,
            (i.trace -> 'meta' -> 'track_b' ->> 'codebook_state')     AS codebook_state,
            ((i.trace -> 'meta' -> 'track_b' ->> 'override_applied')::boolean) AS override_applied,
            -- raw_description: the merchant's verbatim input (xlsx 'Description' cell).
            -- Lets the SPA show a "merchant said X / system saw Y" diff without
            -- digging into declaration_run_items.canonical jsonb.
            (i.canonical ->> 'description')                          AS raw_description,
            -- effective_description: post-Stage-0b cleanup; what Track A retrieval
            -- actually queried against. Reveals when cleanup mangled or stripped
            -- something the merchant supplied.
            (i.trace -> 'meta' -> 'track_a' ->> 'effective_description') AS effective_description
       FROM declaration_run_items i
       LEFT JOIN zatca_hs_code_display d ON d.code = i.final_code
      WHERE i.declaration_run_id = $1
      ORDER BY i.row_index
      LIMIT $2 OFFSET $3`,
    [declarationRun.id, limit, offset],
  );
  // Run total in parallel for the response envelope. Re-running the
  // count on every poll tick is wasteful but tiny (it's just a COUNT(*)
  // on the indexed declaration_run_id); short-circuiting would require
  // caching and complicate the freshness story during live ingestion.
  const totalRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM declaration_run_items WHERE declaration_run_id = $1`,
    [declarationRun.id],
  );
  const total = Number(totalRes.rows[0]?.count ?? 0);
  const itemsFetchedSoFar = offset + r.rows.length;
  const hasMore = itemsFetchedSoFar < total;

  const enrichmentByCode = await enrichCodes(
    r.rows.map((i) => i.final_code),
    req.log,
  );

  return reply.send({
    // Envelope key renamed declaration_run_id → batch_id in the
    // 2026-05-12 API cutover. The DB column is still
    // declaration_run_items.declaration_run_id; only the wire-format
    // name changed.
    batch_id: declarationRun.id,
    // The SPA polls this endpoint while a run is in flight. classification_phase
    // is the authoritative stop signal: keep polling while it's 'pending' or
    // 'running', stop on 'completed' / 'failed'. Per-item `status` covers the
    // individual row state (pending|classifying|succeeded|flagged|blocked|failed).
    classification_phase: declarationRun.classificationStatus,
    total,
    limit,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? itemsFetchedSoFar : null,
    items: r.rows.map((i) => {
      const enrichment = i.final_code ? enrichmentByCode.get(i.final_code) : null;
      return {
        id: i.id,
        row_index: i.row_index,
        status: i.status,
        final_code: i.final_code,
        catalog_path_en: i.catalog_path_en,
        submission_description_ar: i.submission_description_ar,
        classification_status: i.classification_status,
        raw_merchant_code: i.raw_merchant_code,
        codebook_state: i.codebook_state,
        override_applied: i.override_applied ?? false,
        raw_description: i.raw_description,
        effective_description: i.effective_description,
        value_amount: i.value_amount !== null ? Number(i.value_amount) : null,
        currency_code: i.currency_code,
        value_amount_sar: i.value_amount_sar !== null ? Number(i.value_amount_sar) : null,
        fx_rate: i.fx_rate !== null ? Number(i.fx_rate) : null,
        fx_rate_as_of: i.fx_rate_as_of,
        duty_info: enrichment?.duty_info ?? null,
        procedures: enrichment?.procedures ?? [],
        classification_result: i.classification_result,
        trace: i.trace,
        error: i.error,
      };
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
