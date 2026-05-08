/**
 * Top-level declaration-run orchestrator. Thin: delegates to phase services.
 *
 *   1. parse upload                        (parsers/csv|xlsx.parser)
 *   2. resolve operator                      (tenants/operator-config.registry.resolve)
 *   3. canonicalise rows                   (tenants/operator-line-item.mapper)
 *   4. persist source blob + insert        (storage/blob.client + repository)
 *   5. Phase 1 always                      (classification/classification.service)
 *   6. Phase 2 conditional                 (declaration/declaration.service)
 *   7. finalize                            (set declaration_runs.status='completed')
 *
 * The runProcessing() entrypoint is invoked AFTER the route returns 202
 * (background) so the HTTP request doesn't block on Phase 1.
 */
import { resolve as resolveOperator } from '../operators/operator-config.registry.js';
import { mapRowToCanonical, type MapperLookups } from '../operators/operator-line-item.mapper.js';
import { getLookupsByOperatorId } from '../operators/operator-lookups.repository.js';
import { parseCsvBuffer } from './parsers/csv.parser.js';
import { parseXlsxBuffer } from './parsers/xlsx.parser.js';
import { runClassificationPhase } from './classification/classification.service.js';
import {
  insertDeclarationRun,
  setDeclarationRunStatus,
  type DeclarationRunItemInput,
  type InsertDeclarationRunInput,
} from './declaration-run.repository.js';
import { DeclarationRunTooLargeError, DeclarationRunValidationError } from './declaration-run.errors.js';
import { env } from '../../config/env.js';
import { getBlobClient } from '../../storage/blob.client.js';
import { declarationRunPrefix, inputKey } from '../../storage/blob.paths.js';
import type { OperatorConfig } from '../operators/operator-config.types.js';
import type { DeclarationRunMode, DeclarationRunRow } from '../../db/schema.js';
import type { DispatchFn } from '../dispatch/dispatch.contract.ts';
import { newId } from '../../common/utils/uuid.js';

export type UploadKind = 'csv' | 'xlsx';

export interface CreateDeclarationRunInput {
  operatorSlug: string;
  mode: DeclarationRunMode;
  uploadKind: UploadKind;
  /** The raw bytes of the uploaded file. */
  uploadBytes: Buffer;
  metadata: Record<string, unknown>;
  /** Pre-built dispatch function (test seam). */
  dispatch: DispatchFn;
}

export interface CreateDeclarationRunResult {
  declarationRun: DeclarationRunRow;
}

/**
 * Synchronous portion of declaration-run creation:
 *   - validate, parse, canonicalise, persist source, insertDeclarationRun
 *
 * Returns once the declaration_run row + items are written. Caller is
 * responsible for scheduling runProcessing() in the background.
 */
export async function createDeclarationRun(input: CreateDeclarationRunInput): Promise<CreateDeclarationRunResult> {
  const e = env();
  const operator = await resolveOperator(input.operatorSlug);

  const parsed =
    input.uploadKind === 'csv' ? parseCsvBuffer(input.uploadBytes) : parseXlsxBuffer(input.uploadBytes);

  if (parsed.rows.length === 0) {
    throw new DeclarationRunValidationError('uploaded file has no data rows');
  }
  if (parsed.rows.length > e.BATCH_INPUT_MAX_ROWS) {
    throw new DeclarationRunTooLargeError(parsed.rows.length, e.BATCH_INPUT_MAX_ROWS);
  }

  const lookups = await loadLookups(operator);
  const items = canonicaliseRows(parsed.rows, operator, lookups);

  const declarationRunId = newId();
  // Lock the blob prefix in at creation time so every Phase that reads
  // back uses the same date partition, regardless of how long Phase 2
  // takes to start (UTC-fixed, no timezone drift).
  const createdAt = new Date();
  const blobPrefix = declarationRunPrefix({
    operatorSlug: operator.slug,
    createdAt,
    runId: declarationRunId,
  });
  const sourceBlobKey = inputKey(blobPrefix, input.uploadKind);
  const contentType = input.uploadKind === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  await getBlobClient().put(sourceBlobKey, input.uploadBytes, contentType);

  const insertInput: InsertDeclarationRunInput = {
    declarationRunId,
    operatorId: operator.id,
    mode: input.mode,
    sourceBlobKey,
    blobPrefix,
    rowCount: items.length,
    metadata: input.metadata,
    items,
  };
  const declarationRun = await insertDeclarationRun(insertInput);

  return { declarationRun };
}

/** Run Phase 1 (and Phase 2 if mode === 'classify_and_declare'). */
export async function runProcessing(declarationRunId: string, dispatch: DispatchFn): Promise<void> {
  await setDeclarationRunStatus(declarationRunId, { status: 'processing', startedAt: new Date() });
  try {
    await runClassificationPhase(declarationRunId, { dispatch });

    // Phase 2 — declaration. The service no-ops when mode === 'classify_only'.
    const { runDeclarationPhaseIfNeeded } = await import('./filings/declaration.service.js');
    await runDeclarationPhaseIfNeeded(declarationRunId);

    // Phase 3 — manifest. Best-effort: classifications.json + manifest.json
    // land under the run's blob_prefix so a single
    // GET /declaration-runs/:id/download-links returns everything.
    // A failure here doesn't fail the run — the DB rows are authoritative.
    const { writeClassificationsJson, writeManifestJson } = await import('./manifest.js');
    try {
      await writeClassificationsJson(declarationRunId);
      await writeManifestJson(declarationRunId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[manifest] write failed for run', declarationRunId, err);
    }

    await setDeclarationRunStatus(declarationRunId, { status: 'completed', completedAt: new Date() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setDeclarationRunStatus(declarationRunId, {
      status: 'failed',
      completedAt: new Date(),
      error: msg.length > 1000 ? msg.slice(0, 1000) + '…' : msg,
    });
    throw err;
  }
}

async function loadLookups(operator: OperatorConfig): Promise<MapperLookups> {
  const byType = await getLookupsByOperatorId(operator.id);
  return { byType };
}

function canonicaliseRows(
  rows: ReadonlyArray<Record<string, string>>,
  operator: OperatorConfig,
  lookups: MapperLookups,
): DeclarationRunItemInput[] {
  const out: DeclarationRunItemInput[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const canonical = mapRowToCanonical(row, operator, i + 1, lookups);
    out.push({ canonical, rawRow: row });
  }
  return out;
}
