/**
 * HV / LV partitioner for ZATCA Declaration bundling.
 *
 * Two functions are exported:
 *
 *  1. `bundleByAwb` (PR3, AWB-aware, the new path):
 *     Input is pre-grouped: each AWB carries `valueSumSar` (aggregated
 *     across its items) and `items[]`. HV/LV is decided per AWB:
 *       HV  = AWB.valueSumSar >= hvThresholdSar
 *             -> one declaration per AWB (BundleStrategy='HV_STANDALONE'),
 *                with all of that AWB's items inside.
 *       LV  = AWB.valueSumSar < hvThresholdSar
 *             -> pool with other LV AWBs sharing the same manifest,
 *                chunk into bundles of <= lvLineItemCap line items,
 *                **AWB-atomic** (an AWB's items are not split across
 *                bundles) EXCEPT when one AWB alone exceeds lvLineItemCap
 *                — in that case the bundler splits inside the AWB and
 *                emits multiple LV bundles for that single AWB
 *                (2026-05-18 customs spec override).
 *     LV pooling is scoped to one manifest unless
 *     `crossManifestAllowed=true` (configurable, default off per the
 *     2026-05-18 customs spec).
 *
 *  2. `partitionHvLv` (legacy, per-item, kept for backwards compatibility):
 *     Used when items have no AWB linkage (legacy ingest or non-Naqel
 *     operators). Gates each item against hvThresholdSar individually;
 *     LV bundles are item-atomic and capped by bundleSize only. NO
 *     manifest scoping, NO per-bundle SAR cap (the old
 *     `lvInvoiceCapSar` was removed in PR3).
 *
 * Pure functions — no I/O, no DB.
 */
import type { BatchItemRow } from '../../../db/schema.js';
import type { BundleInput } from './declaration.types.js';

// ──────────────────────────────────────────────────────────────────────────
// PR3 — AWB-aware bundler
// ──────────────────────────────────────────────────────────────────────────

export interface AwbForBundling {
  /** awbs.id from the DB; identifies the AWB on the wire and in filing_awbs. */
  awbId: string;
  /** Parent manifest id (manifests.id). LV pooling is bound to this. */
  manifestId: string;
  /** Aggregated invoice value of all items under this AWB, in SAR. */
  valueSumSar: number;
  /**
   * The actual item rows that belong to this AWB. Order preserved on output.
   * Must include every item under the AWB (the bundler does not filter).
   */
  items: ReadonlyArray<BatchItemRow>;
}

export interface BundleByAwbOpts {
  hvThresholdSar: number;
  /**
   * Maximum line items per LV consolidated declaration. Customs spec
   * caps this at 10,000; we ship 9999 as a safety margin (setup_meta
   * key `ZATCA_BUNDLE_SIZE`).
   */
  lvLineItemCap: number;
  /**
   * False (default): LV pooling is bound to a single manifest; AWBs
   * from different manifests never share a bundle.
   * True: LV pooling spans manifests in the same batch (only used when
   * setup_meta.ZATCA_LV_CROSS_MANIFEST_ALLOWED is flipped on).
   */
  crossManifestAllowed: boolean;
}

/**
 * AWB-aware bundle output. Adds `awbIds` so the caller can persist the
 * filing_awbs join. For HV bundles `awbIds` has length 1; for LV
 * bundles it has length N (the AWBs that landed in this consolidated
 * declaration). `manifestId` is the parent for filings.manifest_id (NULL
 * only when crossManifestAllowed=true and the bundle spans manifests;
 * in that case the caller decides whether to leave it null or pick the
 * first AWB's manifest).
 */
export interface AwbBundleOutput {
  strategy: 'HV_STANDALONE' | 'LV_BUNDLED';
  manifestId: string | null;
  awbIds: ReadonlyArray<string>;
  items: ReadonlyArray<BatchItemRow>;
}

export function bundleByAwb(
  awbs: ReadonlyArray<AwbForBundling>,
  opts: BundleByAwbOpts,
): AwbBundleOutput[] {
  if (!Number.isFinite(opts.hvThresholdSar) || opts.hvThresholdSar < 0) {
    throw new RangeError(
      `hvThresholdSar must be a non-negative finite number, got ${opts.hvThresholdSar}`,
    );
  }
  if (!Number.isInteger(opts.lvLineItemCap) || opts.lvLineItemCap < 1) {
    throw new RangeError(
      `lvLineItemCap must be a positive integer, got ${opts.lvLineItemCap}`,
    );
  }

  const out: AwbBundleOutput[] = [];

  // Phase 1 — HV partition: each HV AWB emits its own declaration.
  // Phase 2 — LV partition: pool LV AWBs (per manifest if cross-manifest is off),
  //                         chunk by line-item count with AWB atomicity.
  const lvByManifest = new Map<string, AwbForBundling[]>();

  for (const awb of awbs) {
    if (awb.valueSumSar >= opts.hvThresholdSar) {
      out.push({
        strategy: 'HV_STANDALONE',
        manifestId: awb.manifestId,
        awbIds: [awb.awbId],
        items: awb.items,
      });
      continue;
    }
    const key = opts.crossManifestAllowed ? '__all__' : awb.manifestId;
    let pool = lvByManifest.get(key);
    if (pool === undefined) {
      pool = [];
      lvByManifest.set(key, pool);
    }
    pool.push(awb);
  }

  // LV chunking. For each pool (one per manifest, or one global if
  // crossManifestAllowed), walk AWBs in order. For each AWB:
  //   • If the AWB alone has more items than lvLineItemCap, split
  //     inside the AWB into chunks of <= cap items (per the
  //     2026-05-18 override). Each chunk emits its own bundle.
  //   • Else, append to the current bundle if it fits; flush + start a
  //     new bundle otherwise.
  for (const [manifestKey, pool] of lvByManifest) {
    let currentItems: BatchItemRow[] = [];
    let currentAwbIds: string[] = [];
    let currentManifestId: string | null = null;

    const flush = () => {
      if (currentItems.length === 0) return;
      out.push({
        strategy: 'LV_BUNDLED',
        manifestId: opts.crossManifestAllowed ? null : currentManifestId,
        awbIds: currentAwbIds,
        items: currentItems,
      });
      currentItems = [];
      currentAwbIds = [];
      currentManifestId = null;
    };

    for (const awb of pool) {
      if (awb.items.length > opts.lvLineItemCap) {
        // Oversize-single-AWB override. Flush the current bundle first
        // so the oversize AWB's chunks don't accidentally absorb prior
        // AWBs from the pool. Then emit one bundle per chunk.
        flush();
        for (let i = 0; i < awb.items.length; i += opts.lvLineItemCap) {
          const chunk = awb.items.slice(i, i + opts.lvLineItemCap);
          out.push({
            strategy: 'LV_BUNDLED',
            manifestId: opts.crossManifestAllowed ? null : awb.manifestId,
            awbIds: [awb.awbId],
            items: chunk,
          });
        }
        continue;
      }

      // AWB-atomic packing. If adding this AWB's items would push the
      // running count over the cap, flush the current bundle and start
      // a new one.
      if (currentItems.length + awb.items.length > opts.lvLineItemCap) {
        flush();
      }
      if (currentManifestId === null) currentManifestId = awb.manifestId;
      currentAwbIds.push(awb.awbId);
      currentItems = currentItems.concat(awb.items);
    }
    flush();
    // Silence unused-var lint for the pool key when crossManifestAllowed
    // is true (we still need the key for grouping).
    void manifestKey;
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Legacy — per-item bundler (used when items have no AWB linkage)
// ──────────────────────────────────────────────────────────────────────────

export interface PartitionOpts {
  hvThresholdSar: number;
  bundleSize: number;
}

/**
 * Legacy per-item partitioner. Used when items carry no AWB linkage
 * (legacy ingest, non-Naqel operators). Items are gated against
 * `hvThresholdSar` individually and LV items are packed into bundles of
 * up to `bundleSize` items.
 *
 * No SAR cap (the old `lvInvoiceCapSar` was removed in PR3 per the
 * 2026-05-18 customs spec correction: there is NO per-bundle SAR cap on
 * LV consolidated declarations — only the line-item cap).
 */
export function partitionHvLv(
  items: ReadonlyArray<BatchItemRow>,
  opts: PartitionOpts,
): BundleInput[] {
  if (!Number.isFinite(opts.hvThresholdSar) || opts.hvThresholdSar < 0) {
    throw new RangeError(
      `hvThresholdSar must be a non-negative finite number, got ${opts.hvThresholdSar}`,
    );
  }
  if (!Number.isInteger(opts.bundleSize) || opts.bundleSize < 1) {
    throw new RangeError(`bundleSize must be a positive integer, got ${opts.bundleSize}`);
  }

  const hv: BatchItemRow[] = [];
  const lv: BatchItemRow[] = [];
  for (const item of items) {
    const sarAmount = readSarAmount(item);
    if (sarAmount >= opts.hvThresholdSar) {
      hv.push(item);
    } else {
      lv.push(item);
    }
  }

  const bundles: BundleInput[] = hv.map((it) => ({
    strategy: 'HV_STANDALONE',
    items: [it],
  }));

  let current: BatchItemRow[] = [];
  for (const row of lv) {
    if (current.length >= opts.bundleSize) {
      bundles.push({ strategy: 'LV_BUNDLED', items: current });
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) {
    bundles.push({ strategy: 'LV_BUNDLED', items: current });
  }

  return bundles;
}

function readSarAmount(row: BatchItemRow): number {
  const c = row.canonical;
  if (typeof c.valueAmountSar === 'number' && Number.isFinite(c.valueAmountSar)) {
    return c.valueAmountSar;
  }
  return typeof c.valueAmount === 'number' && Number.isFinite(c.valueAmount) ? c.valueAmount : 0;
}
