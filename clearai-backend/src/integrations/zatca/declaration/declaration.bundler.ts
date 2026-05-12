/**
 * HV / LV partitioner for ZATCA Declaration bundling.
 *
 *   HV (high-value): valueAmount-converted-to-SAR >= operator.hvThresholdSar
 *                    -> one declaration per item (BundleStrategy='HV_STANDALONE')
 *   LV (low-value):  everything else
 *                    -> grouped into chunks of operator.bundleSize
 *                       (BundleStrategy='LV_BUNDLED')
 *
 * Currency conversion: rows can arrive in any currency (Naqel ships AED,
 * SAR, USD, GBP, …). The threshold is SAR, so we convert via the FX helper
 * before comparison. See `fx.ts` for the rate source.
 *
 * Pure function — no I/O, no DB. Input is the rows already classified
 * (status ∈ {succeeded, flagged}); the renderer turns each bundle into XML.
 */
import type { BatchItemRow } from '../../../db/schema.js';
import type { BundleInput } from './declaration.types.js';
import { toSar } from './fx.js';

export interface PartitionOpts {
  hvThresholdSar: number;
  bundleSize: number;
}

export function partitionHvLv(
  items: ReadonlyArray<BatchItemRow>,
  opts: PartitionOpts,
): BundleInput[] {
  if (!Number.isFinite(opts.hvThresholdSar) || opts.hvThresholdSar < 0) {
    throw new RangeError(`hvThresholdSar must be a non-negative finite number, got ${opts.hvThresholdSar}`);
  }
  if (!Number.isInteger(opts.bundleSize) || opts.bundleSize < 1) {
    throw new RangeError(`bundleSize must be a positive integer, got ${opts.bundleSize}`);
  }

  const hv: BatchItemRow[] = [];
  const lv: BatchItemRow[] = [];
  for (const item of items) {
    const sarAmount = readSarAmount(item);
    if (sarAmount >= opts.hvThresholdSar) hv.push(item);
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

function readSarAmount(row: BatchItemRow): number {
  const c = row.canonical;
  const amount = c.valueAmount;
  const code = c.currencyCode;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 0;
  if (typeof code !== 'string' || code === '') return amount;
  return toSar(amount, code);
}
