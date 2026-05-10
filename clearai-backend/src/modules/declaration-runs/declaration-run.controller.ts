/**
 * Thin HTTP layer for declaration-run endpoints. Multipart parse + zod
 * validation + delegation to declaration-run.use-case. Maps errors to the
 * shared envelope.
 */
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { CreateDeclarationRunFieldsSchema, PatchDeclarationRunSchema } from './declaration-run.validation.js';
import { createDeclarationRun, runProcessing, type UploadKind } from './declaration-run.use-case.js';
import {
  cancelDeclarationRunIfActive,
  countItemsByStatus,
  getDeclarationRun,
} from './declaration-run.repository.js';
import { getPool } from '../../db/client.js';
import {
  DeclarationRunValidationError,
  DeclarationRunTooLargeError,
  DeclarationRunNotFoundError,
} from './declaration-run.errors.js';
import { OperatorNotFoundError, RequiredFieldMissingError } from '../operators/operator.errors.js';
import { getOperatorById } from '../operators/operator.repository.js';
import type { DeclarationRunSummary } from './declaration-run.types.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';
import type {
  ClassificationStatus,
  DeclarationStatus,
  DeclarationRunMode,
  DeclarationRunStatus,
} from '../../db/schema.js';

const ACCEPTED_EXTS: Record<string, UploadKind> = {
  csv: 'csv',
  xlsx: 'xlsx',
};

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

export async function handleCreateDeclarationRun(
  req: FastifyRequest,
  reply: FastifyReply,
  dispatch: DispatchFn,
): Promise<unknown> {
  const { file, fields } = await readMultipart(req);

  if (!file) {
    throw new DeclarationRunValidationError('multipart upload missing the `file` part');
  }
  const kind = sniffKindFromFilename(file.filename);
  if (!kind) {
    throw new DeclarationRunValidationError(`unsupported file extension: ${file.filename}`);
  }

  // Decode the metadata field (if present, JSON-encoded).
  let metadataObj: Record<string, unknown> = {};
  if (fields.metadata) {
    try {
      const parsed = JSON.parse(fields.metadata) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadataObj = parsed as Record<string, unknown>;
      } else {
        throw new DeclarationRunValidationError('metadata must be a JSON object');
      }
    } catch {
      throw new DeclarationRunValidationError('metadata must be valid JSON');
    }
  }

  const parsed = CreateDeclarationRunFieldsSchema.safeParse({
    operator_slug: fields.operator_slug,
    mode: fields.mode || undefined,
    callback_url: fields.callback_url || undefined,
    metadata: metadataObj,
  });
  if (!parsed.success) {
    throw new DeclarationRunValidationError('field validation failed', { issues: parsed.error.issues });
  }
  const body = parsed.data;

  const buf = (file as MultipartFile & { _buffer: Buffer })._buffer;

  const { declarationRun } = await createDeclarationRun({
    operatorSlug: body.operator_slug,
    mode: body.mode as DeclarationRunMode,
    uploadKind: kind,
    uploadBytes: buf,
    metadata: { ...body.metadata, original_filename: file.filename, ...(body.callback_url ? { callback_url: body.callback_url } : {}) },
    dispatch,
  });

  // Kick off processing in background; surface the id immediately.
  void runProcessing(declarationRun.id, dispatch).catch((err: unknown) => {
    req.log.error({ err, declaration_run_id: declarationRun.id }, 'background processing failed');
  });

  return reply.code(202).send({
    declaration_run_id: declarationRun.id,
    mode: declarationRun.mode,
    poll_url: `/declaration-runs/${declarationRun.id}`,
    classifications_url: `/declaration-runs/${declarationRun.id}/classifications`,
    ...(declarationRun.mode === 'classify_and_declare'
      ? { declarations_url: `/declaration-runs/${declarationRun.id}/declarations` }
      : {}),
  });
}

export async function handleGetDeclarationRun(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<unknown> {
  const declarationRun = await getDeclarationRun(req.params.id);
  const counts = await countItemsByStatus(declarationRun.id);
  const operator = await getOperatorById(declarationRun.operatorId);
  const summary: DeclarationRunSummary = {
    id: declarationRun.id,
    operator_slug: operator?.slug ?? '',
    mode: declarationRun.mode as DeclarationRunMode,
    status: declarationRun.status as DeclarationRunStatus,
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

export async function handleListClassifications(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<unknown> {
  const declarationRun = await getDeclarationRun(req.params.id);
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
    confidence_band: string | null;
    raw_merchant_code: string | null;
    codebook_state: string | null;
    override_applied: boolean | null;
    raw_description: string | null;
    effective_description: string | null;
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
            (i.trace -> 'meta' -> 'verdict' ->> 'confidence_band')    AS confidence_band,
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
      ORDER BY i.row_index`,
    [declarationRun.id],
  );
  return reply.send({
    declaration_run_id: declarationRun.id,
    // The SPA polls this endpoint while a run is in flight. classification_phase
    // is the authoritative stop signal: keep polling while it's 'pending' or
    // 'running', stop on 'completed' / 'failed'. Per-item `status` covers the
    // individual row state (pending|classifying|succeeded|flagged|blocked|failed).
    classification_phase: declarationRun.classificationStatus,
    items: r.rows.map((i) => ({
      id: i.id,
      row_index: i.row_index,
      status: i.status,
      final_code: i.final_code,
      catalog_path_en: i.catalog_path_en,
      submission_description_ar: i.submission_description_ar,
      confidence_band: i.confidence_band,
      raw_merchant_code: i.raw_merchant_code,
      codebook_state: i.codebook_state,
      override_applied: i.override_applied ?? false,
      raw_description: i.raw_description,
      effective_description: i.effective_description,
      classification_result: i.classification_result,
      trace: i.trace,
      error: i.error,
    })),
  });
}

export async function handlePatchDeclarationRun(
  req: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<unknown> {
  const parsed = PatchDeclarationRunSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new DeclarationRunValidationError('only { status: "cancelled" } is permitted', { issues: parsed.error.issues });
  }
  const updated = await cancelDeclarationRunIfActive(req.params.id);
  return reply.send({ id: updated.id, status: updated.status });
}

export function mapDeclarationRunError(err: unknown): { statusCode: number; body: unknown } | null {
  if (err instanceof DeclarationRunValidationError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  if (err instanceof DeclarationRunTooLargeError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  if (err instanceof DeclarationRunNotFoundError) {
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
