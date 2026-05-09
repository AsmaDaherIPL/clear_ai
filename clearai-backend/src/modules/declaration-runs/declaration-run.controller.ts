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
  if (declarationRun.classificationStatus === 'pending' || declarationRun.classificationStatus === 'running') {
    return reply.code(425).send({ error: { code: 'phase_not_ready', message: 'classification phase still running' } });
  }
  // Single query joins display + submission_descriptions so the SPA
  // result table can render `path_en` and the LLM-generated Arabic
  // submission text per item without follow-up fetches.
  const pool = getPool();
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
  }>(
    `SELECT i.id,
            i.row_index,
            i.status,
            i.final_code,
            i.classification_result,
            i.trace,
            i.error,
            d.path_en              AS catalog_path_en,
            (i.classification_result -> 'goods_description_ar')::text AS submission_description_ar,
            (i.trace -> 'meta' -> 'verdict' ->> 'confidence_band')    AS confidence_band
       FROM declaration_run_items i
       LEFT JOIN zatca_hs_code_display d ON d.code = i.final_code
      WHERE i.declaration_run_id = $1
      ORDER BY i.row_index`,
    [declarationRun.id],
  );
  return reply.send({
    declaration_run_id: declarationRun.id,
    items: r.rows.map((i) => ({
      id: i.id,
      row_index: i.row_index,
      status: i.status,
      final_code: i.final_code,
      catalog_path_en: i.catalog_path_en,
      submission_description_ar: i.submission_description_ar
        ? i.submission_description_ar.replace(/^"|"$/g, '')
        : null,
      confidence_band: i.confidence_band,
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
