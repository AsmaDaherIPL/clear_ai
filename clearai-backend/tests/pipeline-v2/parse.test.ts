/**
 * PR 2 — Parse stage tests (updated PR 13).
 *
 * PR 13: v2/parse.ts (re-export shim) deleted. Import directly from the
 * canonical parse module at pipeline/parse/parse.ts.
 *
 * Mirrors the contract the orchestrator depends on: parse rejects on
 * empty descriptions, accepts otherwise with merchant_code_state set.
 */
import { describe, expect, it } from 'vitest';
import { parseItem } from '../../src/modules/pipeline/parse/parse.js';
import type { CanonicalLineItem } from '../../src/modules/pipeline/types.js';

function item(overrides: Partial<CanonicalLineItem> = {}): CanonicalLineItem {
  return {
    itemId: '00000000-0000-0000-0000-000000000001',
    rowIndex: 1,
    operatorId: 'op-1',
    operatorSlug: 'naqel',
    description: 'cotton t-shirt',
    waybillNo: 'WB1',
    merchantHsCode: '610910000000',
    merchantSku: null,
    valueAmount: 100,
    currencyCode: 'SAR',
    quantity: 1,
    uom: 'PIECE',
    netWeightKg: 0.5,
    clientId: 'C1',
    countryOfOrigin: 'SA',
    destinationStationId: 'DST1',
    consigneeName: 'Test',
    consigneeNationalId: '0000',
    consigneePhone: '0000',
    consigneeAddress: null,
    invoiceDate: null,
    ...overrides,
  } as CanonicalLineItem;
}

describe('v2/parse — accept path', () => {
  it('accepts a typical row and classifies merchant code as twelve_digit', () => {
    const r = parseItem(item({ description: 'cotton t-shirt', merchantHsCode: '610910000000' }));
    expect(r.rejected).toBe(false);
    if (!r.rejected) {
      expect(r.item.raw_description).toBe('cotton t-shirt');
      expect(r.item.merchant_code_state).toBe('twelve_digit');
      expect(r.item.raw_merchant_code).toBe('610910000000');
    }
  });

  it('classifies 6-11 digit codes as short_prefix', () => {
    const r = parseItem(item({ merchantHsCode: '610910' }));
    if (!r.rejected) expect(r.item.merchant_code_state).toBe('short_prefix');
  });

  it('classifies 1-5 digit codes as malformed', () => {
    const r = parseItem(item({ merchantHsCode: '6109' }));
    if (!r.rejected) expect(r.item.merchant_code_state).toBe('malformed');
  });

  it('classifies null merchant code as absent', () => {
    const r = parseItem(item({ merchantHsCode: null }));
    if (!r.rejected) expect(r.item.merchant_code_state).toBe('absent');
  });

  it('classifies non-digit garbage as malformed (non-empty string but no usable digits)', () => {
    const r = parseItem(item({ merchantHsCode: 'parcel' }));
    // 'parcel' is non-empty so classifyMerchantCode doesn't return 'absent'.
    // digits-only stripped to '' (length 0) → falls into the catch-all
    // 'malformed' branch. This matches how legacy + anchored both saw
    // 'parcel' as a merchant_code in production batches.
    if (!r.rejected) expect(r.item.merchant_code_state).toBe('malformed');
  });
});

describe('v2/parse — reject path (BLOCK precursor)', () => {
  it('rejects empty description', () => {
    const r = parseItem(item({ description: '' }));
    expect(r.rejected).toBe(true);
    if (r.rejected) expect(r.reason).toBe('no_description');
  });

  it('rejects whitespace-only description', () => {
    const r = parseItem(item({ description: '   \t\n  ' }));
    expect(r.rejected).toBe(true);
  });

  it('rejects digit-only description (e.g. "565" — invoice number leaked into description column)', () => {
    const r = parseItem(item({ description: '565' }));
    expect(r.rejected).toBe(true);
    if (r.rejected) expect(r.reason).toBe('digit_only_description');
  });

  it('rejects digit-only description with punctuation/whitespace', () => {
    const r = parseItem(item({ description: '  1,234.56  ' }));
    expect(r.rejected).toBe(true);
    if (r.rejected) expect(r.reason).toBe('digit_only_description');
  });

  it('accepts description containing at least one letter in any script (Arabic, Cyrillic, etc.)', () => {
    expect(parseItem(item({ description: 'كولا' })).rejected).toBe(false);
    expect(parseItem(item({ description: 'cola' })).rejected).toBe(false);
    expect(parseItem(item({ description: 'A4' })).rejected).toBe(false);
  });
});
