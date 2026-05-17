import { describe, expect, it, beforeEach } from 'vitest';
import { partitionHvLv } from '../../../src/integrations/zatca/declaration/declaration.bundler.js';
import type { BatchItemRow } from '../../../src/db/schema.js';

beforeEach(() => {
  // FX rates default to {"AED":1.02,"USD":3.75,"EUR":4.05,"GBP":4.75}
  // (env-baked default). fx.toSar is stateless; the previous
  // _resetFxCacheForTests hook was removed when caching was dropped.
  process.env.BATCH_BLOB_CONNECTION ??= 'file://./.local-blob';
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test';
});

// Mirror the FX defaults baked into env.ts so the bundler tests don't
// have to import fx.ts. partitionHvLv now reads canonical.valueAmountSar
// directly (stamped at parse time in production); the helper performs
// the same stamping here so currency-conversion tests still exercise
// the SAR-converted partitioning.
const TEST_FX_TO_SAR: Record<string, number> = {
  SAR: 1,
  AED: 1.02,
  USD: 3.75,
  EUR: 4.05,
  GBP: 4.75,
};

function row(rowIndex: number, valueAmount: number, currencyCode = 'SAR'): BatchItemRow {
  const rate = TEST_FX_TO_SAR[currencyCode] ?? 1; // unknown -> identity
  const valueAmountSar = valueAmount * rate;
  return {
    id: `item-${rowIndex}`,
    declarationRunId: 'set-1',
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

describe('partitionHvLv — SAR amounts', () => {
  it('puts every HV item in its own bundle', () => {
    const items = [row(1, 1500, 'SAR'), row(2, 999, 'SAR'), row(3, 2000, 'SAR')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 1_000_000 });
    const hv = bundles.filter((b) => b.strategy === 'HV_STANDALONE');
    const lv = bundles.filter((b) => b.strategy === 'LV_BUNDLED');
    expect(hv).toHaveLength(2);
    expect(hv.every((b) => b.items.length === 1)).toBe(true);
    expect(lv).toHaveLength(1);
    expect(lv[0]!.items.map((i) => i.rowIndex)).toEqual([2]);
  });

  it('chunks LV items into groups of bundleSize', () => {
    const items = Array.from({ length: 250 }, (_, i) => row(i + 1, 100, 'SAR'));
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 1_000_000 });
    expect(bundles).toHaveLength(3); // 99 + 99 + 52
    expect(bundles[0]!.strategy).toBe('LV_BUNDLED');
    expect(bundles[0]!.items).toHaveLength(99);
    expect(bundles[1]!.items).toHaveLength(99);
    expect(bundles[2]!.items).toHaveLength(52);
  });

  it('handles empty input', () => {
    const bundles = partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 1_000_000 });
    expect(bundles).toEqual([]);
  });

  it('puts items at exactly the threshold into HV', () => {
    const bundles = partitionHvLv([row(1, 1000, 'SAR')], { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 1_000_000 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE');
  });

  it('rejects invalid threshold/bundleSize/cap', () => {
    expect(() => partitionHvLv([], { hvThresholdSar: -1, bundleSize: 99, lvInvoiceCapSar: 1_000_000 })).toThrow(RangeError);
    expect(() => partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 0, lvInvoiceCapSar: 1_000_000 })).toThrow(RangeError);
    expect(() => partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 1.5, lvInvoiceCapSar: 1_000_000 })).toThrow(RangeError);
    expect(() => partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 0 })).toThrow(RangeError);
    expect(() => partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: -1 })).toThrow(RangeError);
  });
});

describe('partitionHvLv — LV invoice cap (0082)', () => {
  // Cap is exclusive: sum(itemCost) must be strictly < lvInvoiceCapSar.
  // Items are themselves < hvThresholdSar (otherwise they would be HV).
  const opts = { hvThresholdSar: 1000, bundleSize: 9999, lvInvoiceCapSar: 1000 };

  it('opens a new bundle once running total would reach the cap', () => {
    // Three rows of 400 SAR: 400 + 400 = 800 (ok); adding the third
    // would land on 1200 -> new bundle. Result: [400,400], [400].
    const items = [row(1, 400), row(2, 400), row(3, 400)];
    const bundles = partitionHvLv(items, opts).filter((b) => b.strategy === 'LV_BUNDLED');
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.items.map((i) => i.rowIndex)).toEqual([1, 2]);
    expect(bundles[1]!.items.map((i) => i.rowIndex)).toEqual([3]);
  });

  it('allows a bundle whose total is just under the cap', () => {
    // 999.99 is allowed (cap is exclusive). One bundle of three items.
    const items = [row(1, 333.33), row(2, 333.33), row(3, 333.33)];
    const bundles = partitionHvLv(items, opts).filter((b) => b.strategy === 'LV_BUNDLED');
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.items).toHaveLength(3);
  });

  it('opens a new bundle when the next item would land exactly on the cap', () => {
    // 500 + 500 = 1000 -> not allowed (exclusive). Split.
    const items = [row(1, 500), row(2, 500)];
    const bundles = partitionHvLv(items, opts).filter((b) => b.strategy === 'LV_BUNDLED');
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.items.map((i) => i.rowIndex)).toEqual([1]);
    expect(bundles[1]!.items.map((i) => i.rowIndex)).toEqual([2]);
  });

  it('chunks 10 items of 999.99 SAR into 10 separate bundles (cap dominates count)', () => {
    const items = Array.from({ length: 10 }, (_, i) => row(i + 1, 999.99));
    const bundles = partitionHvLv(items, opts).filter((b) => b.strategy === 'LV_BUNDLED');
    expect(bundles).toHaveLength(10);
    expect(bundles.every((b) => b.items.length === 1)).toBe(true);
  });

  it('honors bundleSize ceiling when cap is generous', () => {
    // Very cheap items, small bundleSize - the size limit kicks in first.
    const tight = { hvThresholdSar: 1000, bundleSize: 5, lvInvoiceCapSar: 1000 };
    const items = Array.from({ length: 12 }, (_, i) => row(i + 1, 1));
    const bundles = partitionHvLv(items, tight).filter((b) => b.strategy === 'LV_BUNDLED');
    expect(bundles.map((b) => b.items.length)).toEqual([5, 5, 2]);
  });

  it('packs many tiny items into a single LV bundle', () => {
    // 100 items at 5 SAR each = 500 SAR total, well under 1000. One bundle.
    const items = Array.from({ length: 100 }, (_, i) => row(i + 1, 5));
    const bundles = partitionHvLv(items, opts).filter((b) => b.strategy === 'LV_BUNDLED');
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.items).toHaveLength(100);
  });

  it('preserves input order across bundles', () => {
    const items = [row(1, 400), row(2, 700), row(3, 200), row(4, 100)];
    // bundle 0: [1] (400). adding 2 would land 1100 -> split.
    // bundle 1: [2,3] (700+200=900). adding 4 -> 1000, exclusive -> split.
    // bundle 2: [4] (100).
    const bundles = partitionHvLv(items, opts).filter((b) => b.strategy === 'LV_BUNDLED');
    expect(bundles).toHaveLength(3);
    expect(bundles[0]!.items.map((i) => i.rowIndex)).toEqual([1]);
    expect(bundles[1]!.items.map((i) => i.rowIndex)).toEqual([2, 3]);
    expect(bundles[2]!.items.map((i) => i.rowIndex)).toEqual([4]);
  });
});

describe('partitionHvLv — currency conversion (G7)', () => {
  it('converts AED to SAR before threshold check', () => {
    // env default: AED -> 1.02 SAR. 980 AED = 999.6 SAR (LV).
    // 1000 AED = 1020 SAR (HV).
    const items = [row(1, 980, 'AED'), row(2, 1000, 'AED')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 1_000_000 });
    const hv = bundles.filter((b) => b.strategy === 'HV_STANDALONE');
    const lv = bundles.filter((b) => b.strategy === 'LV_BUNDLED');
    expect(hv).toHaveLength(1);
    expect(hv[0]!.items[0]!.rowIndex).toBe(2);
    expect(lv).toHaveLength(1);
    expect(lv[0]!.items[0]!.rowIndex).toBe(1);
  });

  it('converts USD to SAR (USD->3.75)', () => {
    // 300 USD = 1125 SAR (HV at threshold 1000)
    // 200 USD = 750 SAR (LV)
    const items = [row(1, 300, 'USD'), row(2, 200, 'USD')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 1_000_000 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE');
    expect(bundles[1]!.strategy).toBe('LV_BUNDLED');
  });

  it('unknown currency falls back to identity (treats raw amount as SAR)', () => {
    const items = [row(1, 1500, 'XYZ'), row(2, 100, 'XYZ')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 1_000_000 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE'); // 1500 >= 1000
    expect(bundles[1]!.strategy).toBe('LV_BUNDLED');
  });

  it('mixed currencies in one batch are converted correctly', () => {
    // SAR row: 1500 SAR (HV)
    // AED row: 500 AED = 510 SAR (LV)
    // USD row: 500 USD = 1875 SAR (HV)
    const items = [row(1, 1500, 'SAR'), row(2, 500, 'AED'), row(3, 500, 'USD')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99, lvInvoiceCapSar: 1_000_000 });
    const hv = bundles.filter((b) => b.strategy === 'HV_STANDALONE');
    const lv = bundles.filter((b) => b.strategy === 'LV_BUNDLED');
    expect(hv).toHaveLength(2);
    expect(hv.map((b) => b.items[0]!.rowIndex).sort()).toEqual([1, 3]);
    expect(lv).toHaveLength(1);
    expect(lv[0]!.items[0]!.rowIndex).toBe(2);
  });
});
