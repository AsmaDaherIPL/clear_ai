/**
 * manifest.json + classifications.json writer.
 *
 * Fires once at the end of a declaration run (after Phase 2, or after
 * Phase 1 for classify_only runs). Both files land under the run's
 * blob_prefix so a single GET /declaration-runs/:id/download-links
 * returns everything the SPA needs.
 *
 * classifications.json shape: array of { rowIndex, status, finalCode,
 *                                        goodsDescriptionAr, error }
 *
 * manifest.json shape: { runId, operatorSlug, mode, createdAt,
 *                        completedAt, files: [{ kind, name, sizeBytes,
 *                                               contentType }] }
 */
import { getBlobClient } from '../../storage/blob.client.js';
import { classificationsKey, manifestKey } from '../../storage/blob.paths.js';
import { listClassifiedItems } from './filings/declaration.repository.js';
import { listPendingItems } from './classification/classification.repository.js';
import { getDeclarationRun } from './declaration-run.repository.js';
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

/**
 * Write classifications.json (per-item Phase 1 results) under the run's
 * blob_prefix. Best-effort: a write failure logs but doesn't fail the
 * run — the DB rows remain authoritative.
 */
export async function writeClassificationsJson(declarationRunId: string): Promise<void> {
  const run = await getDeclarationRun(declarationRunId);
  if (!run.blobPrefix) return;

  // listClassifiedItems returns post-Phase-1 succeeded/flagged rows;
  // listPendingItems also returns blocked/failed. We want the union for
  // the dump so the JSON reflects every row.
  const succeededOrFlagged = await listClassifiedItems(declarationRunId);
  const all = await listPendingItems(declarationRunId);

  const byId = new Map<string, unknown>();
  for (const r of all) byId.set(r.id, r);
  for (const r of succeededOrFlagged) byId.set(r.id, r);

  const dump = Array.from(byId.values());
  const body = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
  await getBlobClient().put(classificationsKey(run.blobPrefix), body, 'application/json');
}

/**
 * List every blob under the run prefix and write a manifest.json index.
 * Called at the very end of a run so it captures input.csv,
 * classifications.json, and every hv/lv XML produced.
 */
export async function writeManifestJson(declarationRunId: string): Promise<void> {
  const run = await getDeclarationRun(declarationRunId);
  if (!run.blobPrefix) return;
  const operatorRow = await getOperatorById(run.operatorId);

  const blob = getBlobClient();
  const items = await blob.list(run.blobPrefix);

  const files: ManifestFile[] = items
    // Don't include the manifest itself.
    .filter((i) => !i.key.endsWith('/manifest.json'))
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
  await blob.put(manifestKey(run.blobPrefix), body, 'application/json');
}
