/**
 * Per-run blob index — writes `run-index.json` at the declaration run's
 * blob prefix, listing every file in the run with kind/size/content-type.
 *
 * Naming note: this used to be called "manifest" (manifest.ts +
 * manifest.json). Renamed because "manifest" in customs logistics refers
 * specifically to the air-waybill submission that precedes the
 * declaration (see project_zatca_two_step_flow memory rule); using it for
 * an internal blob index overloaded the term. The reader path
 * (route handler) is tolerant of both filenames so historical batches
 * still resolve.
 */
import { getBlobClient } from '../../storage/blob.client.js';
import { classificationsKey, runIndexKey } from '../../storage/blob.paths.js';
import { listClassifiedItems } from './filings/declaration.repository.js';
import { listPendingItems } from './classification/classification.repository.js';
import { getBatch } from './declaration-run.repository.js';
import { getOperatorById } from '../operators/operator.repository.js';

export interface RunIndexFile {
  /**
   * Kind classification of a file inside a run's blob prefix. `run_index`
   * is the index file itself (this module's output). Other kinds are
   * payload artifacts produced by the pipeline.
   */
  kind: 'input' | 'classifications' | 'run_index' | 'hv' | 'lv';
  name: string;
  sizeBytes: number | null;
  contentType: string | null;
}

export interface RunIndex {
  runId: string;
  operatorSlug: string;
  mode: string;
  createdAt: string;
  completedAt: string;
  files: RunIndexFile[];
}

export async function writeClassificationsJson(declarationRunId: string): Promise<void> {
  const run = await getBatch(declarationRunId);
  if (!run.blobPrefix) return;

  // Union both lists: listClassifiedItems is post-Phase-1 only
  // (succeeded/flagged), listPendingItems also covers blocked/failed.
  const succeededOrFlagged = await listClassifiedItems(declarationRunId);
  const all = await listPendingItems(declarationRunId);

  const byId = new Map<string, unknown>();
  for (const r of all) byId.set(r.id, r);
  for (const r of succeededOrFlagged) byId.set(r.id, r);

  const dump = Array.from(byId.values());
  const body = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
  await getBlobClient().put(classificationsKey(run.blobPrefix), body, 'application/json');
}

export async function writeRunIndexJson(declarationRunId: string): Promise<void> {
  const run = await getBatch(declarationRunId);
  if (!run.blobPrefix) return;
  const operatorRow = await getOperatorById(run.operatorId);

  const blob = getBlobClient();
  const items = await blob.list(run.blobPrefix);

  // Filter out the index file itself AND the legacy manifest.json (for
  // mixed buckets where a historical batch's index is still present).
  const files: RunIndexFile[] = items
    .filter((i) => !i.key.endsWith('/run-index.json') && !i.key.endsWith('/manifest.json'))
    .map((i) => {
      const rel = i.key.startsWith(`${run.blobPrefix}/`)
        ? i.key.slice(run.blobPrefix!.length + 1)
        : i.key;
      let kind: RunIndexFile['kind'];
      if (rel === 'input.csv' || rel === 'input.xlsx') kind = 'input';
      else if (rel === 'classifications.json') kind = 'classifications';
      else if (rel.startsWith('hv/')) kind = 'hv';
      else if (rel.startsWith('lv/')) kind = 'lv';
      else kind = 'run_index';
      return {
        kind,
        name: rel,
        sizeBytes: i.sizeBytes,
        contentType: i.contentType,
      };
    });

  const runIndex: RunIndex = {
    runId: run.id,
    operatorSlug: operatorRow?.slug ?? 'unknown',
    mode: run.mode,
    createdAt: run.createdAt.toISOString(),
    completedAt: new Date().toISOString(),
    files,
  };

  const body = Buffer.from(JSON.stringify(runIndex, null, 2), 'utf8');
  await blob.put(runIndexKey(run.blobPrefix), body, 'application/json');
}
