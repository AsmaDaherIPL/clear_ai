/**
 * HV / LV partitioner for ZATCA Declaration bundling.
 *
 *   HV (high-value): item.canonical.valueAmount >= tenant.hvThresholdSar
 *                    -> one declaration per item (BundleStrategy='HV_STANDALONE')
 *   LV (low-value):  everything else
 *                    -> grouped into chunks of tenant.bundleSize
 *                       (BundleStrategy='LV_BUNDLED')
 *
 * Pure function — no I/O, no DB. Input is the rows already classified
 * (status ∈ {succeeded, flagged}); the renderer turns each bundle into XML.
 */
import type { DeclarationSetItemRow } from '../../../db/schema.js';
import type { BundleInput } from './declaration.types.js';

export interface PartitionOpts {
  hvThresholdSar: number;
  bundleSize: number;
}

export function partitionHvLv(
  items: ReadonlyArray<DeclarationSetItemRow>,
  opts: PartitionOpts,
): BundleInput[] {
  if (!Number.isFinite(opts.hvThresholdSar) || opts.hvThresholdSar < 0) {
    throw new RangeError(`hvThresholdSar must be a non-negative finite number, got ${opts.hvThresholdSar}`);
  }
  if (!Number.isInteger(opts.bundleSize) || opts.bundleSize < 1) {
    throw new RangeError(`bundleSize must be a positive integer, got ${opts.bundleSize}`);
  }

  const hv: DeclarationSetItemRow[] = [];
  const lv: DeclarationSetItemRow[] = [];
  for (const item of items) {
    const value = readValueAmount(item);
    if (value >= opts.hvThresholdSar) hv.push(item);
    else lv.push(item);
  }

  const bundles: BundleInput[] = hv.map((it) => ({
    strategy: 'HV_STANDALONE',
    items: [it],
  }));

  for (let i = 0; i < lv.length; i += opts.bundleSize) {
    bundles.push({
      strategy: 'LV_BUNDLED',
      items: lv.slice(i, i + opts.bundleSize),
    });
  }

  return bundles;
}

function readValueAmount(row: DeclarationSetItemRow): number {
  const v = row.canonical.valueAmount;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
