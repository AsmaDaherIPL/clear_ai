import { describe, expect, it, beforeEach } from 'vitest';
import {
  partitionHvLv,
  bundleByAwb,
  type AwbForBundling,
} from '../../../src/integrations/zatca/declaration/declaration.bundler.js';
import type { BatchItemRow } from '../../../src/db/schema.js';

beforeEach(() => {
  process.env.BATCH_BLOB_CONNECTION ??= 'file://./.local-blob';
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test';
});

const TEST_FX_TO_SAR: Record<string, number> = {
  SAR: 1,
  AED: 1.02,
  USD: 3.75,
  EUR: 4.05,
  GBP: 4.75,
};

function row(rowIndex: number, valueAmount: number, currencyCode = 'SAR'): BatchItemRow {
  const rate = TEST_FX_TO_SAR[currencyCode] ?? 1;
  const valueAmountSar = valueAmount * rate;
  return {
    id: `item-${rowIndex}`,
    batchId: 'set-1',
    awbId: null,
    rowIndex,
    canonical: { valueAmount, valueAmountSar, currencyCode } as Record<string, unknown>,
    status: 'succeeded',
    finalCode: '610910000099',
    classificationResult: null,
    trace: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as BatchItemRow;
}

// ─────────────────────────────────────────────────────────────────────────
// Legacy partitionHvLv — per-item HV/LV, no AWB linkage
// ─────────────────────────────────────────────────────────────────────────

describe('partitionHvLv — SAR amounts (legacy per-item path)', () => {
  it('puts every HV item in its own bundle', () => {
    const items = [row(1, 1500, 'SAR'), row(2, 999, 'SAR'), row(3, 2000, 'SAR')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    const hv = bundles.filter((b) => b.strategy === 'HV_STANDALONE');
    const lv = bundles.filter((b) => b.strategy === 'LV_BUNDLED');
    expect(hv).toHaveLength(2);
    expect(hv.every((b) => b.items.length === 1)).toBe(true);
    expect(lv).toHaveLength(1);
    expect(lv[0]!.items.map((i) => i.rowIndex)).toEqual([2]);
  });

  it('chunks LV items into groups of bundleSize', () => {
    const items = Array.from({ length: 250 }, (_, i) => row(i + 1, 100, 'SAR'));
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    expect(bundles).toHaveLength(3); // 99 + 99 + 52
    expect(bundles[0]!.strategy).toBe('LV_BUNDLED');
    expect(bundles[0]!.items).toHaveLength(99);
    expect(bundles[1]!.items).toHaveLength(99);
    expect(bundles[2]!.items).toHaveLength(52);
  });

  it('handles empty input', () => {
    const bundles = partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 99 });
    expect(bundles).toEqual([]);
  });

  it('puts items at exactly the threshold into HV', () => {
    const bundles = partitionHvLv([row(1, 1000, 'SAR')], { hvThresholdSar: 1000, bundleSize: 99 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE');
  });

  it('rejects invalid threshold/bundleSize', () => {
    expect(() => partitionHvLv([], { hvThresholdSar: -1, bundleSize: 99 })).toThrow(RangeError);
    expect(() => partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 0 })).toThrow(RangeError);
    expect(() => partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 1.5 })).toThrow(RangeError);
  });
});

describe('partitionHvLv — currency conversion', () => {
  it('converts AED to SAR before threshold check', () => {
    const items = [row(1, 980, 'AED'), row(2, 1000, 'AED')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    const hv = bundles.filter((b) => b.strategy === 'HV_STANDALONE');
    const lv = bundles.filter((b) => b.strategy === 'LV_BUNDLED');
    expect(hv).toHaveLength(1);
    expect(hv[0]!.items[0]!.rowIndex).toBe(2);
    expect(lv).toHaveLength(1);
    expect(lv[0]!.items[0]!.rowIndex).toBe(1);
  });

  it('converts USD to SAR (USD->3.75)', () => {
    const items = [row(1, 300, 'USD'), row(2, 200, 'USD')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE');
    expect(bundles[1]!.strategy).toBe('LV_BUNDLED');
  });

  it('unknown currency falls back to identity (treats raw amount as SAR)', () => {
    const items = [row(1, 1500, 'XYZ'), row(2, 100, 'XYZ')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE');
    expect(bundles[1]!.strategy).toBe('LV_BUNDLED');
  });

  it('mixed currencies in one batch are converted correctly', () => {
    const items = [row(1, 1500, 'SAR'), row(2, 500, 'AED'), row(3, 500, 'USD')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    const hv = bundles.filter((b) => b.strategy === 'HV_STANDALONE');
    const lv = bundles.filter((b) => b.strategy === 'LV_BUNDLED');
    expect(hv).toHaveLength(2);
    expect(hv.map((b) => b.items[0]!.rowIndex).sort()).toEqual([1, 3]);
    expect(lv).toHaveLength(1);
    expect(lv[0]!.items[0]!.rowIndex).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PR3 — AWB-aware bundleByAwb
// ─────────────────────────────────────────────────────────────────────────

function awb(opts: {
  awbId: string;
  manifestId: string;
  valueSumSar: number;
  itemCount: number;
  startingRowIndex: number;
}): AwbForBundling {
  const items: BatchItemRow[] = Array.from({ length: opts.itemCount }, (_, i) =>
    row(opts.startingRowIndex + i, 0, 'SAR'),
  );
  return {
    awbId: opts.awbId,
    manifestId: opts.manifestId,
    valueSumSar: opts.valueSumSar,
    items,
  };
}

describe('bundleByAwb — HV/LV gating at AWB level (PR3)', () => {
  it('emits one HV_STANDALONE per AWB whose value sum >= threshold', () => {
    const awbs = [
      awb({ awbId: 'a1', manifestId: 'm1', valueSumSar: 1500, itemCount: 5, startingRowIndex: 1 }),
      awb({ awbId: 'a2', manifestId: 'm1', valueSumSar: 800, itemCount: 2, startingRowIndex: 10 }),
      awb({ awbId: 'a3', manifestId: 'm1', valueSumSar: 1000, itemCount: 1, startingRowIndex: 20 }),
    ];
    const out = bundleByAwb(awbs, {
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: false,
    });
    const hv = out.filter((b) => b.strategy === 'HV_STANDALONE');
    const lv = out.filter((b) => b.strategy === 'LV_BUNDLED');
    expect(hv).toHaveLength(2);
    expect(hv.map((b) => b.awbIds[0])).toEqual(['a1', 'a3']);
    expect(hv[0]!.items).toHaveLength(5);
    expect(lv).toHaveLength(1);
    expect(lv[0]!.awbIds).toEqual(['a2']);
  });

  it('LV pool is scoped to a single manifest by default', () => {
    const awbs = [
      awb({ awbId: 'a1', manifestId: 'm1', valueSumSar: 100, itemCount: 2, startingRowIndex: 1 }),
      awb({ awbId: 'a2', manifestId: 'm2', valueSumSar: 100, itemCount: 2, startingRowIndex: 10 }),
    ];
    const out = bundleByAwb(awbs, {
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: false,
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.manifestId).toBe('m1');
    expect(out[1]!.manifestId).toBe('m2');
  });

  it('crossManifestAllowed=true pools LV AWBs from different manifests', () => {
    const awbs = [
      awb({ awbId: 'a1', manifestId: 'm1', valueSumSar: 100, itemCount: 2, startingRowIndex: 1 }),
      awb({ awbId: 'a2', manifestId: 'm2', valueSumSar: 100, itemCount: 2, startingRowIndex: 10 }),
    ];
    const out = bundleByAwb(awbs, {
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.strategy).toBe('LV_BUNDLED');
    expect(out[0]!.manifestId).toBeNull();
    expect(out[0]!.awbIds).toEqual(['a1', 'a2']);
  });

  it('chunks LV pool by line-item cap, AWB-atomic', () => {
    // Three AWBs of 40 items each = 120 items total; cap = 100. Atomic
    // packing means AWBs fit whole: first two AWBs land in bundle 1 (80
    // items), third AWB starts bundle 2 (40 items).
    const awbs = [
      awb({ awbId: 'a1', manifestId: 'm1', valueSumSar: 100, itemCount: 40, startingRowIndex: 1 }),
      awb({ awbId: 'a2', manifestId: 'm1', valueSumSar: 100, itemCount: 40, startingRowIndex: 100 }),
      awb({ awbId: 'a3', manifestId: 'm1', valueSumSar: 100, itemCount: 40, startingRowIndex: 200 }),
    ];
    const out = bundleByAwb(awbs, {
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: false,
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.awbIds).toEqual(['a1', 'a2']);
    expect(out[0]!.items).toHaveLength(80);
    expect(out[1]!.awbIds).toEqual(['a3']);
    expect(out[1]!.items).toHaveLength(40);
  });

  it('oversize-single-AWB override splits inside the AWB', () => {
    // One AWB has 250 items, cap is 100. Per the 2026-05-18 customs spec
    // override (#7), the atomicity rule yields and the AWB is split into
    // chunks of 100, 100, 50.
    const awbs = [
      awb({ awbId: 'a1', manifestId: 'm1', valueSumSar: 100, itemCount: 250, startingRowIndex: 1 }),
    ];
    const out = bundleByAwb(awbs, {
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: false,
    });
    expect(out).toHaveLength(3);
    expect(out[0]!.items).toHaveLength(100);
    expect(out[1]!.items).toHaveLength(100);
    expect(out[2]!.items).toHaveLength(50);
    expect(out.every((b) => b.awbIds.length === 1 && b.awbIds[0] === 'a1')).toBe(true);
  });

  it('oversize-single-AWB flushes the current bundle before splitting', () => {
    // First AWB has 30 items (well under cap), then a 200-item AWB
    // arrives. The 30-item bundle must flush; the 200-item AWB then
    // splits into two bundles of 100. Result: 3 bundles total.
    const awbs = [
      awb({ awbId: 'small', manifestId: 'm1', valueSumSar: 100, itemCount: 30, startingRowIndex: 1 }),
      awb({ awbId: 'huge', manifestId: 'm1', valueSumSar: 100, itemCount: 200, startingRowIndex: 100 }),
    ];
    const out = bundleByAwb(awbs, {
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: false,
    });
    expect(out).toHaveLength(3);
    expect(out[0]!.awbIds).toEqual(['small']);
    expect(out[0]!.items).toHaveLength(30);
    expect(out[1]!.awbIds).toEqual(['huge']);
    expect(out[1]!.items).toHaveLength(100);
    expect(out[2]!.awbIds).toEqual(['huge']);
    expect(out[2]!.items).toHaveLength(100);
  });

  it('empty pool returns empty', () => {
    const out = bundleByAwb([], {
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: false,
    });
    expect(out).toEqual([]);
  });

  it('rejects invalid thresholds', () => {
    const opts = (over: Partial<{ hvThresholdSar: number; lvLineItemCap: number }>) => ({
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: false,
      ...over,
    });
    expect(() => bundleByAwb([], opts({ hvThresholdSar: -1 }))).toThrow(RangeError);
    expect(() => bundleByAwb([], opts({ lvLineItemCap: 0 }))).toThrow(RangeError);
    expect(() => bundleByAwb([], opts({ lvLineItemCap: 1.5 }))).toThrow(RangeError);
  });

  it('HV AWB carries its full manifest_id through to the bundle output', () => {
    const awbs = [
      awb({ awbId: 'a1', manifestId: 'm-abc', valueSumSar: 2000, itemCount: 3, startingRowIndex: 1 }),
    ];
    const out = bundleByAwb(awbs, {
      hvThresholdSar: 1000,
      lvLineItemCap: 100,
      crossManifestAllowed: false,
    });
    expect(out[0]!.manifestId).toBe('m-abc');
    expect(out[0]!.strategy).toBe('HV_STANDALONE');
  });
});
