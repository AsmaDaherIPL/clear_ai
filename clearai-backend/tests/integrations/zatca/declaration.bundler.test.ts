import { describe, expect, it } from 'vitest';
import { partitionHvLv } from '../../../src/integrations/zatca/declaration/declaration.bundler.js';
import type { DeclarationSetItemRow } from '../../../src/db/schema.js';

function row(rowIndex: number, valueAmount: number): DeclarationSetItemRow {
  return {
    id: `item-${rowIndex}`,
    declarationSetId: 'set-1',
    rowIndex,
    canonical: { valueAmount } as Record<string, unknown>,
    status: 'succeeded',
    finalCode: '610910000099',
    classificationResult: null,
    trace: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as DeclarationSetItemRow;
}

describe('partitionHvLv', () => {
  it('puts every HV item in its own bundle', () => {
    const items = [row(1, 1500), row(2, 999), row(3, 2000)];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    const hv = bundles.filter((b) => b.strategy === 'HV_STANDALONE');
    const lv = bundles.filter((b) => b.strategy === 'LV_BUNDLED');
    expect(hv).toHaveLength(2);
    expect(hv.every((b) => b.items.length === 1)).toBe(true);
    expect(lv).toHaveLength(1);
    expect(lv[0]!.items.map((i) => i.rowIndex)).toEqual([2]);
  });

  it('chunks LV items into groups of bundleSize', () => {
    const items = Array.from({ length: 250 }, (_, i) => row(i + 1, 100));
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
    const items = [row(1, 1000)];
    const bundles = partitionHvLv(items, { hvThresholdSar: 1000, bundleSize: 99 });
    expect(bundles[0]!.strategy).toBe('HV_STANDALONE');
  });

  it('rejects invalid threshold/bundleSize', () => {
    expect(() => partitionHvLv([], { hvThresholdSar: -1, bundleSize: 99 })).toThrow(RangeError);
    expect(() => partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 0 })).toThrow(RangeError);
    expect(() => partitionHvLv([], { hvThresholdSar: 1000, bundleSize: 1.5 })).toThrow(RangeError);
  });
});
