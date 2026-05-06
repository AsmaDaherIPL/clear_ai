import { describe, expect, it, beforeEach } from 'vitest';
import { partitionHvLv } from '../../../src/integrations/zatca/declaration/declaration.bundler.js';
import { _resetFxCacheForTests } from '../../../src/integrations/zatca/declaration/fx.js';
import type { DeclarationRunItemRow } from '../../../src/db/schema.js';

beforeEach(() => {
  // FX rates default to {"AED":1.02,"USD":3.75,"EUR":4.05,"GBP":4.75}
  // (env-baked default). Reset cache between tests so explicit env overrides
  // take effect.
  process.env.BATCH_BLOB_CONNECTION ??= 'file://./.local-blob';
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test';
  _resetFxCacheForTests();
});

function row(rowIndex: number, valueAmount: number, currencyCode = 'SAR'): DeclarationRunItemRow {
  return {
    id: `item-${rowIndex}`,
    declarationRunId: 'set-1',
    rowIndex,
    canonical: { valueAmount, currencyCode } as Record<string, unknown>,
    status: 'succeeded',
    finalCode: '610910000099',
    classificationResult: null,
    trace: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as DeclarationRunItemRow;
}

describe('partitionHvLv — SAR amounts', () => {
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

describe('partitionHvLv — currency conversion (G7)', () => {
  it('converts AED to SAR before threshold check', () => {
    // env default: AED -> 1.02 SAR. 980 AED = 999.6 SAR (LV).
    // 1000 AED = 1020 SAR (HV).
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
    // 300 USD = 1125 SAR (HV at threshold 1000)
    // 200 USD = 750 SAR (LV)
    const items = [row(1, 300, 'USD'), row(2, 200, 'USD')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE');
    expect(bundles[1]!.strategy).toBe('LV_BUNDLED');
  });

  it('unknown currency falls back to identity (treats raw amount as SAR)', () => {
    const items = [row(1, 1500, 'XYZ'), row(2, 100, 'XYZ')];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE'); // 1500 >= 1000
    expect(bundles[1]!.strategy).toBe('LV_BUNDLED');
  });

  it('mixed currencies in one batch are converted correctly', () => {
    // SAR row: 1500 SAR (HV)
    // AED row: 500 AED = 510 SAR (LV)
    // USD row: 500 USD = 1875 SAR (HV)
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
