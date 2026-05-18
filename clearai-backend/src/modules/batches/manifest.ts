import { getBlobClient } from '../../storage/blob.client.js';
import { classificationsKey, runIndexKey } from '../../storage/blob.paths.js';
import { listClassifiedItems } from './filings/declaration.repository.js';
import { listPendingItems } from './classification/classification.repository.js';
import { getBatch } from './batch.repository.js';
import { getOperatorById } from '../operators/operator.repository.js';

export interface ManifestFile {
  kind: 'input' | 'classifications' | 'manifest' | 'hv' | 'lv';
  name: string;
  sizeBytes: number | null;
  contentType: string | null;
}

export interface RunManifest {
  runId: string;
  operatorSlug: string;
  mode: string;
  createdAt: string;
  completedAt: string;
  files: ManifestFile[];
}

export async function writeClassificationsJson(batchId: string): Promise<void> {
  const run = await getBatch(batchId);
  if (!run.blobPrefix) return;

  // Union both lists: listClassifiedItems is post-Phase-1 only
  // (succeeded/flagged), listPendingItems also covers blocked/failed.
  const succeededOrFlagged = await listClassifiedItems(batchId);
  const all = await listPendingItems(batchId);

  const byId = new Map<string, unknown>();
  for (const r of all) byId.set(r.id, r);
  for (const r of succeededOrFlagged) byId.set(r.id, r);

  const dump = Array.from(byId.values());
  const body = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
  await getBlobClient().put(classificationsKey(run.blobPrefix), body, 'application/json');
}

export async function writeManifestJson(batchId: string): Promise<void> {
  const run = await getBatch(batchId);
  if (!run.blobPrefix) return;
  const operatorRow = await getOperatorById(run.operatorId);

  const blob = getBlobClient();
  const items = await blob.list(run.blobPrefix);

  const files: ManifestFile[] = items
    .filter((i) => !i.key.endsWith('/run-index.json') && !i.key.endsWith('/manifest.json'))
    .map((i) => {
      const rel = i.key.startsWith(`${run.blobPrefix}/`)
        ? i.key.slice(run.blobPrefix!.length + 1)
        : i.key;
      let kind: ManifestFile['kind'];
      if (rel === 'input.csv' || rel === 'input.xlsx') kind = 'input';
      else if (rel === 'classifications.json') kind = 'classifications';
      else if (rel.startsWith('hv/')) kind = 'hv';
      else if (rel.startsWith('lv/')) kind = 'lv';
      else kind = 'manifest';
      return {
        kind,
        name: rel,
        sizeBytes: i.sizeBytes,
        contentType: i.contentType,
      };
    });

  const manifest: RunManifest = {
    runId: run.id,
    operatorSlug: operatorRow?.slug ?? 'unknown',
    mode: run.mode,
    createdAt: run.createdAt.toISOString(),
    completedAt: new Date().toISOString(),
    files,
  };

  const body = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  await blob.put(runIndexKey(run.blobPrefix), body, 'application/json');
}
