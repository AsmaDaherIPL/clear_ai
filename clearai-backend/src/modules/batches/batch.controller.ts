/**
 * Thin HTTP layer for batch endpoints. Multipart parse + zod validation +
 * delegation to batch.use-case. Maps errors to the shared envelope.
 */
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { CreateBatchFieldsSchema, PatchBatchSchema } from './batch.validation.js';
import { createBatch, runProcessing, type UploadKind } from './batch.use-case.js';
import {
  cancelBatchIfActive,
  countItemsByStatus,
  getBatch,
  listItems,
} from './batch.repository.js';
import { BatchValidationError, BatchTooLargeError, BatchNotFoundError } from './batch.errors.js';
import { TenantNotFoundError, RequiredFieldMissingError } from '../tenants/tenant.errors.js';
import type { BatchSummary } from './batch.types.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';
import type { BatchClassificationStatus, BatchDeclarationStatus, BatchMode, BatchStatus } from '../../db/schema.js';

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

  // Decode the metadata field (if present, JSON-encoded).
  let metadataObj: Record<string, unknown> = {};
  if (fields.metadata) {
    try {
      const parsed = JSON.parse(fields.metadata) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadataObj = parsed as Record<string, unknown>;
      } else {
        throw new BatchValidationError('metadata must be a JSON object');
      }
    } catch {
      throw new BatchValidationError('metadata must be valid JSON');
    }
  }

  const parsed = CreateBatchFieldsSchema.safeParse({
    tenant_slug: fields.tenant_slug,
    mode: fields.mode || undefined,
    callback_url: fields.callback_url || undefined,
    metadata: metadataObj,
  });
  if (!parsed.success) {
    throw new BatchValidationError('field validation failed', { issues: parsed.error.issues });
  }
  const body = parsed.data;

  const buf = (file as MultipartFile & { _buffer: Buffer })._buffer;

  const { batch } = await createBatch({
    tenantSlug: body.tenant_slug,
    mode: body.mode as BatchMode,
    uploadKind: kind,
    uploadBytes: buf,
    metadata: { ...body.metadata, original_filename: file.filename, ...(body.callback_url ? { callback_url: body.callback_url } : {}) },
    dispatch,
  });

  // Kick off processing in background; surface the batch id immediately.
  void runProcessing(batch.id, dispatch).catch((err: unknown) => {
    req.log.error({ err, batch_id: batch.id }, 'background processing failed');
  });

  return reply.code(202).send({
    batch_id: batch.id,
    mode: batch.mode,
    poll_url: `/batches/${batch.id}`,
    classifications_url: `/batches/${batch.id}/classifications`,
    ...(batch.mode === 'classify_and_declare' ? { declarations_url: `/batches/${batch.id}/declarations` } : {}),
  });
}

export async function handleGetBatch(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<unknown> {
  const batch = await getBatch(req.params.id);
  const counts = await countItemsByStatus(batch.id);
  const summary: BatchSummary = {
    id: batch.id,
    tenant_slug: batch.tenant,
    mode: batch.mode as BatchMode,
    status: batch.status as BatchStatus,
    classification_status: batch.classificationStatus as BatchClassificationStatus,
    declaration_status: (batch.declarationStatus ?? null) as BatchDeclarationStatus | null,
    row_count: batch.rowCount,
    succeeded: counts.succeeded,
    flagged: counts.flagged,
    blocked: counts.blocked,
    failed: counts.failed,
    pending: counts.pending + counts.classifying,
    started_at: batch.startedAt?.toISOString() ?? null,
    completed_at: batch.completedAt?.toISOString() ?? null,
    error: batch.error,
  };
  return reply.send(summary);
}

export async function handleListClassifications(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<unknown> {
  const batch = await getBatch(req.params.id);
  if (batch.classificationStatus === 'pending' || batch.classificationStatus === 'running') {
    return reply.code(425).send({ error: { code: 'phase_not_ready', message: 'classification phase still running' } });
  }
  const items = await listItems(batch.id);
  return reply.send({
    batch_id: batch.id,
    items: items.map((i) => ({
      id: i.id,
      row_index: i.rowIndex,
      status: i.status,
      final_code: i.finalCode,
      classification_result: i.classificationResult,
      trace: i.trace,
      error: i.error,
    })),
  });
}

export async function handlePatchBatch(req: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply): Promise<unknown> {
  const parsed = PatchBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BatchValidationError('only { status: "cancelled" } is permitted', { issues: parsed.error.issues });
  }
  const updated = await cancelBatchIfActive(req.params.id);
  return reply.send({ id: updated.id, status: updated.status });
}

export function mapBatchError(err: unknown): { statusCode: number; body: unknown } | null {
  if (err instanceof BatchValidationError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  if (err instanceof BatchTooLargeError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  if (err instanceof BatchNotFoundError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof TenantNotFoundError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof RequiredFieldMissingError) {
    return { statusCode: err.statusCode, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  return null;
}

export async function attachBatchPlugins(app: FastifyInstance): Promise<void> {
  // Idempotent register guard via Symbol marker.
  const KEY = Symbol.for('clearai.multipart.registered');
  const flag = (app as unknown as Record<symbol, unknown>)[KEY];
  if (flag) return;
  const multipart = (await import('@fastify/multipart')).default;
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB cap, matches Container Apps' default body limit.
      files: 1,
    },
  });
  (app as unknown as Record<symbol, unknown>)[KEY] = true;
}
