/**
 * HV / LV partitioner for ZATCA Declaration bundling.
 *
 *   HV (high-value): valueAmount-converted-to-SAR >= opts.hvThresholdSar
 *                    -> one declaration per item (BundleStrategy='HV_STANDALONE')
 *   LV (low-value):  everything else
 *                    -> grouped into bundles bounded by BOTH:
 *                         a) item count   <= opts.bundleSize
 *                         b) sum(itemCost) < opts.lvInvoiceCapSar  (exclusive)
 *                       (BundleStrategy='LV_BUNDLED')
 *
 * The LV cap is the real ZATCA/Tabadul rule: an LV consolidated invoice
 * must have a total cost strictly less than 1000 SAR. The per-item HV
 * threshold and the per-bundle LV cap are complementary — items already
 * routed HV are >= 1000 SAR each (so they cannot be in the LV pool), and
 * within the LV pool the bundler must respect the per-invoice ceiling.
 *
 * Packing is greedy first-fit-in-order: walk LV items in input order, add
 * to the current bundle until either the count limit or the cap would be
 * breached, then start a new bundle. We do not sort or optimise — items
 * are independent and Naqel pays per declaration, but a smarter packer
 * (FFD/BFD) would only reduce bundle count by a small constant; not worth
 * the complexity until operators complain.
 *
 * Currency conversion: rows can arrive in any currency (Naqel ships AED,
 * SAR, USD, GBP, …). Both thresholds are SAR, so we convert via the FX
 * helper at parse time and read `valueAmountSar` here.
 *
 * Pure function — no I/O, no DB. Input is rows already classified
 * (status ∈ {succeeded, flagged}); the renderer turns each bundle into XML.
 */
import type { BatchItemRow } from '../../../db/schema.js';
import type { BundleInput } from './declaration.types.js';

export interface PartitionOpts {
  hvThresholdSar: number;
  bundleSize: number;
  /**
   * Per-bundle invoiceCost ceiling in SAR (exclusive). Sum of itemCost
   * across an LV bundle must be strictly less than this. See migration
   * 0082 for context.
   */
  lvInvoiceCapSar: number;
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
  if (!Number.isFinite(opts.lvInvoiceCapSar) || opts.lvInvoiceCapSar <= 0) {
    throw new RangeError(`lvInvoiceCapSar must be a positive finite number, got ${opts.lvInvoiceCapSar}`);
  }

  const hv: BatchItemRow[] = [];
  const lv: Array<{ row: BatchItemRow; sar: number }> = [];
  for (const item of items) {
    const sarAmount = readSarAmount(item);
    if (sarAmount >= opts.hvThresholdSar) {
      hv.push(item);
    } else {
      lv.push({ row: item, sar: sarAmount });
    }
  }

  const bundles: BundleInput[] = hv.map((it) => ({
    strategy: 'HV_STANDALONE',
    items: [it],
  }));

  // Greedy LV bin packing: respect count AND cap. An item enters the
  // current bundle iff doing so keeps both (a) count <= bundleSize and
  // (b) running total < lvInvoiceCapSar. Otherwise we close the current
  // bundle and open a new one.
  let current: BatchItemRow[] = [];
  let currentSum = 0;
  for (const { row, sar } of lv) {
    const wouldExceedCount = current.length + 1 > opts.bundleSize;
    const wouldExceedCap = currentSum + sar >= opts.lvInvoiceCapSar;
    if (current.length > 0 && (wouldExceedCount || wouldExceedCap)) {
      bundles.push({ strategy: 'LV_BUNDLED', items: current });
      current = [];
      currentSum = 0;
    }
    current.push(row);
    currentSum += sar;
  }
  if (current.length > 0) {
    bundles.push({ strategy: 'LV_BUNDLED', items: current });
  }

  return bundles;
}

function readSarAmount(row: BatchItemRow): number {
  // Post 2026-05-13: parse stamps valueAmountSar on every item with a valid
  // (value_amount, currency_code). Render reads it directly — no per-item
  // FX lookup at bundle time. Fall back to raw amount only for legacy rows.
  const c = row.canonical;
  if (typeof c.valueAmountSar === 'number' && Number.isFinite(c.valueAmountSar)) {
    return c.valueAmountSar;
  }
  return typeof c.valueAmount === 'number' && Number.isFinite(c.valueAmount) ? c.valueAmount : 0;
}
