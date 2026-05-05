/**
 * Top-level batch orchestrator. Thin: delegates to phase services.
 *
 *   1. parse upload                       (parsers/csv|xlsx.parser)
 *   2. resolve tenant                     (tenants/tenant-config.registry.resolve)
 *   3. canonicalise rows                  (tenants/tenant-line-item.mapper)
 *   4. persist source blob + insertBatch  (storage/blob.client + batch.repository)
 *   5. Phase 1 always                     (classification/batch-classification.service)
 *   6. Phase 2 conditional                (declaration/batch-declaration.service)  (Phase 5)
 *   7. finalize                           (set batches.status='completed')
 *
 * The runProcessing() entrypoint is invoked AFTER the route returns 202
 * (background) so the HTTP request doesn't block on Phase 1.
 */
import { resolve as resolveTenant } from '../tenants/tenant-config.registry.js';
import { mapRowToCanonical, type MapperLookups } from '../tenants/tenant-line-item.mapper.js';
import { getLookupsBySlug } from '../tenants/tenant-lookups.repository.js';
import { parseCsvBuffer } from './parsers/csv.parser.js';
import { parseXlsxBuffer } from './parsers/xlsx.parser.js';
import { runClassificationPhase } from './classification/batch-classification.service.js';
import {
  insertBatch,
  setBatchStatus,
  type BatchItemInput,
  type InsertBatchInput,
} from './batch.repository.js';
import { BatchTooLargeError, BatchValidationError } from './batch.errors.js';
import { env } from '../../config/env.js';
import { getBlobClient } from '../../storage/blob.client.js';
import { inputKey } from '../../storage/blob.paths.js';
import type { TenantConfig } from '../tenants/tenant-config.types.js';
import type { BatchMode, BatchRow } from '../../db/schema.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';
import { newId } from '../../common/utils/uuid.js';

export type UploadKind = 'csv' | 'xlsx';

export interface CreateBatchInput {
  tenantSlug: string;
  mode: BatchMode;
  uploadKind: UploadKind;
  /** The raw bytes of the uploaded file. */
  uploadBytes: Buffer;
  metadata: Record<string, unknown>;
  /** Pre-built dispatch function (test seam). */
  dispatch: DispatchFn;
}

export interface CreateBatchResult {
  batch: BatchRow;
}

/**
 * Synchronous portion of batch creation:
 *   - validate, parse, canonicalise, persist source, insertBatch
 *
 * Returns once the batch row + items are written. Caller is responsible for
 * scheduling runProcessing() in the background.
 */
export async function createBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
  const e = env();
  const tenant = await resolveTenant(input.tenantSlug);

  const parsed =
    input.uploadKind === 'csv' ? parseCsvBuffer(input.uploadBytes) : parseXlsxBuffer(input.uploadBytes);

  if (parsed.rows.length === 0) {
    throw new BatchValidationError('uploaded file has no data rows');
  }
  if (parsed.rows.length > e.BATCH_INPUT_MAX_ROWS) {
    throw new BatchTooLargeError(parsed.rows.length, e.BATCH_INPUT_MAX_ROWS);
  }

  const lookups = await loadLookups(tenant);
  const items = canonicaliseRows(parsed.rows, tenant, lookups);

  const batchId = newId();
  const sourceBlobKey = inputKey(batchId, input.uploadKind);
  const contentType = input.uploadKind === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  await getBlobClient().put(sourceBlobKey, input.uploadBytes, contentType);

  const insertInput: InsertBatchInput = {
    batchId,
    tenantSlug: tenant.slug,
    mode: input.mode,
    sourceBlobKey,
    rowCount: items.length,
    metadata: input.metadata,
    items,
  };
  const batch = await insertBatch(insertInput);

  return { batch };
}

/** Run Phase 1 (and later Phase 2 once the declaration service ships). */
export async function runProcessing(batchId: string, dispatch: DispatchFn): Promise<void> {
  await setBatchStatus(batchId, { status: 'processing', startedAt: new Date() });
  try {
    await runClassificationPhase(batchId, { dispatch });

    // Phase 2 — declaration. Wired in by Phase 5.
    // The declaration service no-ops when mode === 'classify_only'.
    const { runDeclarationPhaseIfNeeded } = await import('./declaration/batch-declaration.service.js');
    await runDeclarationPhaseIfNeeded(batchId);

    await setBatchStatus(batchId, { status: 'completed', completedAt: new Date() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setBatchStatus(batchId, {
      status: 'failed',
      completedAt: new Date(),
      error: msg.length > 1000 ? msg.slice(0, 1000) + '…' : msg,
    });
    throw err;
  }
}

async function loadLookups(tenant: TenantConfig): Promise<MapperLookups> {
  const byType = await getLookupsBySlug(tenant.slug);
  return { byType };
}

function canonicaliseRows(
  rows: ReadonlyArray<Record<string, string>>,
  tenant: TenantConfig,
  lookups: MapperLookups,
): BatchItemInput[] {
  const out: BatchItemInput[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const canonical = mapRowToCanonical(row, tenant, i + 1, lookups);
    out.push({ canonical, rawRow: row });
  }
  return out;
}

