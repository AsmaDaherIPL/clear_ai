/**
 * Phase 2 implementation. Lives in a separate file from the service so
 * the entrypoint (runDeclarationPhaseIfNeeded) stays small and testable.
 *
 * Pulls every dependency the renderer needs once per batch
 * (operator config, lookups-with-metadata) and threads them into the pure
 * renderer per bundle.
 *
 * PR3: chooses between AWB-aware bundling and the legacy per-item path
 * based on whether the batch's items carry awb_id linkage. Hierarchical
 * ingest (Naqel CSV) sets awb_id; legacy ingest leaves it NULL.
 */
import {
  markDeclarationPhase,
  listClassifiedItems,
  recordDeclaration,
} from './declaration.repository.js';
import { listAllItemsByBatch } from '../classification/classification.repository.js';
import type { PhaseDeclarationSummary } from './declaration.types.js';
import { resolve as resolveOperator } from '../../operators/operator-config.registry.js';
import { getOperatorById } from '../../operators/operator.repository.js';
import { getLookupsByOperatorIdWithMetadata } from '../../operators/operator-lookups.repository.js';
import { loadDeclarationConfig } from '../../operators/operator-declaration-config.repository.js';
import {
  bundleByAwb,
  partitionHvLv,
  type AwbForBundling,
} from '../../../integrations/zatca/declaration/declaration.bundler.js';
import { renderDeclarationXml } from '../../../integrations/zatca/declaration/declaration.template.js';
import { getBlobClient } from '../../../storage/blob.client.js';
import { filingKey } from '../../../storage/blob.paths.js';
import { getBatch } from '../batch.repository.js';
import { listAwbsByBatch } from '../manifest.repository.js';
import { newId } from '../../../common/utils/uuid.js';
import { loadThresholds, isEnabled } from '../../reference-data/setup-meta.repository.js';
import type { BatchItemRow } from '../../../db/schema.js';

export async function runDeclarationPhase(batchId: string): Promise<PhaseDeclarationSummary> {
  const startMs = Date.now();
  await markDeclarationPhase(batchId, 'running');

  const batch = await getBatch(batchId);
  const operatorRow = await getOperatorById(batch.operatorId);
  if (!operatorRow) {
    throw new Error(`operator ${batch.operatorId} not found for batch ${batchId}`);
  }
  const operator = await resolveOperator(operatorRow.slug);
  const blobPrefix = batch.blobPrefix;
  if (!blobPrefix) {
    throw new Error(
      `batch ${batchId} has no blob_prefix; runs created before 0061 cannot be re-rendered.`,
    );
  }
  const lookups = await getLookupsByOperatorIdWithMetadata(operator.id);
  const items = await listClassifiedItems(batchId);
  // All rows in the batch regardless of classification status. Used by
  // the renderer to populate <exportAirBL> with HITL-failed AWBs too —
  // those represent shipments physically on the flight even though no
  // classifiable <item> was emitted for them.
  const allBatchRows = await listAllItemsByBatch(batchId);

  const [thresholds, config] = await Promise.all([
    loadThresholds(),
    loadDeclarationConfig(operator.id),
  ]);

  // PR3 path selection. If at least one item has awb_id set, we treat
  // the batch as hierarchical and use the AWB-aware bundler. Otherwise
  // we fall back to the per-item legacy partitioner — that path keeps
  // working for legacy ingest and non-Naqel operators without a
  // hierarchy.
  const hasAwbLinkage = items.some((it) => it.awbId !== null && it.awbId !== undefined);

  const blob = getBlobClient();
  const now = new Date();

  if (!config.zatcaSubmitterCarrierId) {
    throw new Error(
      `Operator '${operator.slug}' has no zatca_submitter_carrier_id configured. ` +
      `An admin must populate operator_declaration_config.zatca_submitter_carrier_id ` +
      `with the value assigned at the operator's ZATCA registration before declaration ` +
      `rendering can run.`,
    );
  }

  let bundleCount = 0;

  if (hasAwbLinkage) {
    // ── PR3 path: group items by awb_id, hand to bundleByAwb ──
    const awbRows = await listAwbsByBatch(batchId);
    const awbsForBundling = buildAwbsForBundling(awbRows, items);

    const bundles = bundleByAwb(awbsForBundling, {
      hvThresholdSar: thresholds.ZATCA_HV_THRESHOLD_SAR,
      lvLineItemCap: thresholds.ZATCA_BUNDLE_SIZE,
      crossManifestAllowed: isEnabled(thresholds, 'ZATCA_LV_CROSS_MANIFEST_ALLOWED'),
    });

    let bundleIndex = 0;
    for (const bundle of bundles) {
      // Source rows that should appear in <exportAirBL> for this
      // bundle. Match on rawRow.ManifestFile so HITL-failed rows from
      // the same manifest are included (their awbId is null so the
      // AWB-aware bundler couldn't pick them up). Fall back to bundle
      // items when the manifest filename isn't accessible.
      const manifestFiles = collectManifestFiles(bundle.items);
      const allBlSources =
        manifestFiles.size > 0
          ? allBatchRows.filter((r) => {
              const mf = readManifestFile(r);
              return mf !== null && manifestFiles.has(mf);
            })
          : bundle.items;
      const xml = renderDeclarationXml({
        operator: {
          slug: operator.slug,
          displayName: operator.displayName,
          identity: operator.identity,
        },
        config,
        bundleStrategy: bundle.strategy,
        items: bundle.items,
        allBlSources,
        lookups,
        now,
      });
      const filingId = newId();
      const key = filingKey({ prefix: blobPrefix, strategy: bundle.strategy, filingId });
      await blob.put(key, Buffer.from(xml, 'utf8'), 'application/xml');
      await recordDeclaration({
        filingId,
        batchId,
        bundleIndex,
        strategy: bundle.strategy,
        itemCount: bundle.items.length,
        blobKey: key,
        manifestId: bundle.manifestId,
        awbIds: bundle.awbIds,
      });
      bundleIndex++;
    }
    bundleCount = bundles.length;
  } else {
    // ── Legacy path: per-item HV/LV partitioner, no AWB linkage ──
    const bundles = partitionHvLv(items, {
      hvThresholdSar: thresholds.ZATCA_HV_THRESHOLD_SAR,
      bundleSize: thresholds.ZATCA_BUNDLE_SIZE,
    });

    let bundleIndex = 0;
    for (const bundle of bundles) {
      const manifestFiles = collectManifestFiles(bundle.items);
      const allBlSources =
        manifestFiles.size > 0
          ? allBatchRows.filter((r) => {
              const mf = readManifestFile(r);
              return mf !== null && manifestFiles.has(mf);
            })
          : bundle.items;
      const xml = renderDeclarationXml({
        operator: {
          slug: operator.slug,
          displayName: operator.displayName,
          identity: operator.identity,
        },
        config,
        bundleStrategy: bundle.strategy,
        items: bundle.items,
        allBlSources,
        lookups,
        now,
      });
      const filingId = newId();
      const key = filingKey({ prefix: blobPrefix, strategy: bundle.strategy, filingId });
      await blob.put(key, Buffer.from(xml, 'utf8'), 'application/xml');
      await recordDeclaration({
        filingId,
        batchId,
        bundleIndex,
        strategy: bundle.strategy,
        itemCount: bundle.items.length,
        blobKey: key,
      });
      bundleIndex++;
    }
    bundleCount = bundles.length;
  }

  await markDeclarationPhase(batchId, 'completed');

  return {
    bundleCount,
    durationMs: Date.now() - startMs,
  };
}

/**
 * Build the AwbForBundling[] payload for the AWB-aware bundler. Groups
 * the (already filtered) batch_items rows by awb_id, sums their SAR
 * value, and pairs each awb_id with its parent manifest_id from awbs.
 *
 * Items with awb_id=null are silently dropped — those rows are legacy
 * and should not appear in this code path (the caller chose
 * hasAwbLinkage=true). If they do appear, dropping them is the safer
 * behaviour than fabricating a synthetic AWB.
 */
function buildAwbsForBundling(
  awbRows: ReadonlyArray<{ id: string; manifestId: string }>,
  items: ReadonlyArray<BatchItemRow>,
): AwbForBundling[] {
  const manifestByAwb = new Map<string, string>();
  for (const a of awbRows) manifestByAwb.set(a.id, a.manifestId);

  const grouped = new Map<string, { items: BatchItemRow[]; sum: number }>();
  for (const item of items) {
    if (item.awbId === null || item.awbId === undefined) continue;
    let entry = grouped.get(item.awbId);
    if (entry === undefined) {
      entry = { items: [], sum: 0 };
      grouped.set(item.awbId, entry);
    }
    entry.items.push(item);
    const c = item.canonical;
    const sar =
      typeof c.valueAmountSar === 'number' && Number.isFinite(c.valueAmountSar)
        ? c.valueAmountSar
        : typeof c.valueAmount === 'number' && Number.isFinite(c.valueAmount)
          ? c.valueAmount
          : 0;
    entry.sum += sar;
  }

  const out: AwbForBundling[] = [];
  for (const [awbId, entry] of grouped) {
    const manifestId = manifestByAwb.get(awbId);
    if (manifestId === undefined) {
      // FK guarantees this can't happen in practice — items.awb_id refs
      // awbs.id which has a manifest_id. Defensive log + skip rather
      // than fail the phase.
      // eslint-disable-next-line no-console
      console.warn(`[bundler] awb ${awbId} has items but no manifest link; skipped`);
      continue;
    }
    out.push({
      awbId,
      manifestId,
      valueSumSar: entry.sum,
      items: entry.items,
    });
  }
  return out;
}

/**
 * Pull `rawRow.ManifestFile` from a BatchItemRow when present. rawRow
 * is the verbatim source row preserved at ingest. Returns null when
 * the field isn't there (legacy rows pre-hierarchy, or non-Naqel
 * operators that don't carry a ManifestFile column).
 */
function readManifestFile(row: BatchItemRow): string | null {
  const raw = row.rawRow as Record<string, unknown> | null | undefined;
  if (!raw) return null;
  const v = raw['ManifestFile'];
  if (typeof v !== 'string' || v.length === 0) return null;
  return v;
}

/**
 * Collect the distinct ManifestFile values from a bundle's items.
 * Used to scope the per-bundle <exportAirBL> source set so HITL-
 * failed rows from the same manifest can be included without
 * cross-pollinating from other manifests in the batch.
 */
function collectManifestFiles(items: ReadonlyArray<BatchItemRow>): Set<string> {
  const set = new Set<string>();
  for (const it of items) {
    const mf = readManifestFile(it);
    if (mf !== null) set.add(mf);
  }
  return set;
}
