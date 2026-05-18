/**
 * Top-level batch orchestrator. Thin: delegates to phase services.
 *
 *   1. parse upload                        (parsers/csv|xlsx.parser)
 *   2. resolve operator                      (tenants/operator-config.registry.resolve)
 *   3. canonicalise rows                   (tenants/operator-line-item.mapper)
 *   4. persist source blob + insert        (storage/blob.client + repository)
 *   5. Phase 1 always                      (classification/classification.service)
 *   6. Phase 2 conditional                 (declaration/declaration.service)
 *   7. finalize                            (set batches.status='completed')
 *
 * The runProcessing() entrypoint is invoked AFTER the route returns 202
 * (background) so the HTTP request doesn't block on Phase 1.
 */
import { resolve as resolveOperator } from '../operators/operator-config.registry.js';
import { mapRowToCanonical, type MapperLookups } from '../operators/operator-line-item.mapper.js';
import { stampFxFields, FxRateMissingError } from '../pipeline/parse/enrich-fx.js';
import { getLookupsByOperatorId } from '../operators/operator-lookups.repository.js';
import { parseCsvBuffer } from './parsers/csv.parser.js';
import { parseXlsxBuffer } from './parsers/xlsx.parser.js';
import { groupNaqelCsv, type GroupedNaqelCsv } from './parsers/naqel-csv.grouper.js';
import { runClassificationPhase } from './classification/classification.service.js';
import {
  insertBatch,
  setBatchStatus,
  type BatchItemInput,
  type InsertBatchInput,
} from './batch.repository.js';
import { BatchTooLargeError, BatchValidationError } from './batch.errors.js';
import { env } from '../../config/env.js';
import { getBlobClient } from '../../storage/blob.client.js';
import { batchPrefix, inputKey } from '../../storage/blob.paths.js';
import type { OperatorConfig } from '../operators/operator-config.types.js';
import type { BatchMode, BatchRow } from '../../db/schema.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';
import { newId } from '../../common/utils/uuid.js';

export type UploadKind = 'csv' | 'xlsx';

export interface CreateBatchInput {
  operatorSlug: string;
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
 * Returns once the batch row + items are written. Caller is
 * responsible for scheduling runProcessing() in the background.
 */
export async function createBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
  const e = env();
  const operator = await resolveOperator(input.operatorSlug);

  const parsed =
    input.uploadKind === 'csv' ? parseCsvBuffer(input.uploadBytes) : parseXlsxBuffer(input.uploadBytes);

  if (parsed.rows.length === 0) {
    throw new BatchValidationError('uploaded file has no data rows');
  }
  if (parsed.rows.length > e.BATCH_INPUT_MAX_ROWS) {
    throw new BatchTooLargeError(parsed.rows.length, e.BATCH_INPUT_MAX_ROWS);
  }

  // PR3: if the upload carries Naqel-style manifest/AWB columns
  // (ManifestedTime + WayBillNo present in the header), group rows into
  // the customs hierarchy and emit it alongside the canonicalised items.
  // The grouper marks each item with its temp AWB id, which the
  // repository resolves to a real UUID inside the transaction.
  const headers = new Set(Object.keys(parsed.rows[0] ?? {}));
  const isNaqelHierarchical = headers.has('WayBillNo');
  let hierarchy: GroupedNaqelCsv | undefined;
  if (isNaqelHierarchical) {
    hierarchy = groupNaqelCsv(parsed.rows, { operatorSlug: operator.slug });
  }

  const lookups = await loadLookups(operator);
  let items: BatchItemInput[];
  try {
    items = await canonicaliseRows(parsed.rows, operator, lookups);
  } catch (err) {
    if (err instanceof FxRateMissingError) {
      throw new BatchValidationError(err.message, {
        code: err.code,
        currency: err.currency,
        as_of: err.asOfDate,
      });
    }
    throw err;
  }

  // Stamp each canonical item with its grouped AWB temp id so the
  // repository can resolve temp->real. Order is preserved by both the
  // grouper and canonicaliseRows (input row order, 1:1).
  if (hierarchy !== undefined) {
    for (let i = 0; i < items.length; i++) {
      const grouped = hierarchy.items[i];
      const it = items[i];
      if (grouped !== undefined && it !== undefined) {
        // canonical.awbId is typed as string | undefined; we put the
        // TempAwbId here. The repository overwrites it with the real
        // UUID before persisting to batch_items.
        it.canonical = { ...it.canonical, awbId: grouped.awbTempId };
      }
    }
  }

  const batchId = newId();
  // Lock the blob prefix in at creation time so every Phase that reads
  // back uses the same date partition, regardless of how long Phase 2
  // takes to start (UTC-fixed, no timezone drift).
  const createdAt = new Date();
  const blobPrefix = batchPrefix({
    operatorSlug: operator.slug,
    createdAt,
    runId: batchId,
  });
  const sourceBlobKey = inputKey(blobPrefix, input.uploadKind);
  const contentType = input.uploadKind === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  await getBlobClient().put(sourceBlobKey, input.uploadBytes, contentType);

  const insertInput: InsertBatchInput = {
    batchId,
    operatorId: operator.id,
    mode: input.mode,
    sourceBlobKey,
    blobPrefix,
    rowCount: items.length,
    metadata: input.metadata,
    items,
    hierarchy,
  };
  const batch = await insertBatch(insertInput);

  return { batch };
}

/**
 * Phase tag attached to the run-level error string so the SPA's run-summary
 * banner can render "Phase 2 — declaration build failed" instead of the
 * generic "Run failed". Tracks which phase the throw came from.
 */
type ProcessingPhase = 'classification' | 'declaration' | 'unknown';

/**
 * Format the run-level error string with a structured prefix the SPA can
 * parse. Shape: `[phase=<phase> code=<code>] <message>`. The code field is
 * dropped when the underlying error doesn't expose one. Frontend grep-ability
 * is the only contract — the human-readable message after the bracket stays
 * the source of truth for display.
 */
export const __test__ = { formatRunError };

function formatRunError(phase: ProcessingPhase, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const codeAttr =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? ` code=${(err as { code: string }).code}`
      : '';
  const tagged = `[phase=${phase}${codeAttr}] ${msg}`;
  return tagged.length > 1000 ? tagged.slice(0, 1000) + '…' : tagged;
}

/** Run Phase 1 (and Phase 2 if mode === 'classify_and_declare'). */
export async function runProcessing(batchId: string, dispatch: DispatchFn): Promise<void> {
  await setBatchStatus(batchId, { status: 'processing', startedAt: new Date() });
  let currentPhase: ProcessingPhase = 'unknown';
  try {
    currentPhase = 'classification';
    await runClassificationPhase(batchId, { dispatch });

    // Phase 2 — declaration. The service no-ops when mode === 'classify_only'.
    currentPhase = 'declaration';
    const { runDeclarationPhaseIfNeeded } = await import('./filings/declaration.service.js');
    await runDeclarationPhaseIfNeeded(batchId);

    // Phase 3 — run index. Best-effort: classifications.json + run-index.json
    // land under the batch's blob_prefix so a single
    // GET /batches/:id/files returns everything.
    // A failure here doesn't fail the batch — the DB rows are authoritative.
    const { writeClassificationsJson, writeRunIndexJson } = await import('./run-index.js');
    try {
      await writeClassificationsJson(batchId);
      await writeRunIndexJson(batchId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[run-index] write failed for batch', batchId, err);
    }

    await setBatchStatus(batchId, { status: 'completed', completedAt: new Date() });
  } catch (err) {
    await setBatchStatus(batchId, {
      status: 'failed',
      completedAt: new Date(),
      error: formatRunError(currentPhase, err),
    });
    throw err;
  }
}

async function loadLookups(operator: OperatorConfig): Promise<MapperLookups> {
  const byType = await getLookupsByOperatorId(operator.id);
  return { byType };
}

async function canonicaliseRows(
  rows: ReadonlyArray<Record<string, string>>,
  operator: OperatorConfig,
  lookups: MapperLookups,
): Promise<BatchItemInput[]> {
  const out: BatchItemInput[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const canonical = await stampFxFields(mapRowToCanonical(row, operator, i + 1, lookups));
    out.push({ canonical, rawRow: row });
  }
  return out;
}
