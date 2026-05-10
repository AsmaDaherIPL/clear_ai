/**
 * Verifies the Stage 0a parser pads zero-stripped Naqel merchant codes back
 * up to the next valid HS boundary. Naqel manifests strip trailing zeros
 * from canonical 12-digit ZATCA codes; without padding, a 7-digit "8518311"
 * was being marked malformed and Track B short-circuited to no_signal.
 */
import { describe, it, expect } from 'vitest';
import { parseItem } from '../../src/modules/pipeline/stage-0-parse/parse.js';
import type { CanonicalLineItem } from '../../src/modules/operators/operator-config.types.js';

function line(merchantHsCode: string | null): CanonicalLineItem {
  return {
    itemId: 'test',
    operatorSlug: 'naqel',
    operatorId: null,
    description: 'placeholder',
    merchantHsCode,
    valueAmount: 100,
    currencyCode: 'SAR',
  } as unknown as CanonicalLineItem;
}

describe('parseItem — merchant code length classification + Naqel zero-strip recovery', () => {
  it('classifies 12 digits as twelve_digit; normalized equals raw', () => {
    const r = parseItem(line('851831100000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('twelve_digit');
    expect(r.item.raw_merchant_code).toBe('851831100000');
    expect(r.item.normalized_merchant_code).toBe('851831100000');
  });

  it('pads 11 digits to 12 (twelve_digit)', () => {
    const r = parseItem(line('85183110000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('twelve_digit');
    expect(r.item.raw_merchant_code).toBe('85183110000');
    expect(r.item.normalized_merchant_code).toBe('851831100000');
  });

  it('classifies 10 digits as short_prefix; normalized equals raw', () => {
    const r = parseItem(line('8518311000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.normalized_merchant_code).toBe('8518311000');
  });

  it('pads 9 digits to 10 (short_prefix)', () => {
    const r = parseItem(line('851831100'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.raw_merchant_code).toBe('851831100');
    expect(r.item.normalized_merchant_code).toBe('8518311000');
  });

  it('classifies 8 digits as short_prefix; normalized equals raw', () => {
    const r = parseItem(line('85183110'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.normalized_merchant_code).toBe('85183110');
  });

  it('pads 7 digits to 8 (the actual Naqel headphones case from 2026-05-09)', () => {
    const r = parseItem(line('8518311'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.raw_merchant_code).toBe('8518311');
    expect(r.item.normalized_merchant_code).toBe('85183110');
  });

  it('pads 7 digits to 8 (the actual Naqel basket case from 2026-05-09)', () => {
    const r = parseItem(line('6307911'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.normalized_merchant_code).toBe('63079110');
  });

  it('classifies 6 digits as short_prefix; normalized equals raw', () => {
    const r = parseItem(line('851831'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.normalized_merchant_code).toBe('851831');
  });

  it('rejects 5 digits as malformed; normalized null', () => {
    const r = parseItem(line('85183'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('malformed');
    expect(r.item.normalized_merchant_code).toBeNull();
  });

  it('rejects 13 digits as malformed; normalized null', () => {
    const r = parseItem(line('8518311000000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('malformed');
    expect(r.item.normalized_merchant_code).toBeNull();
  });

  it('strips non-digits before classifying ("8518.31.10" → 8 digits → short_prefix)', () => {
    const r = parseItem(line('8518.31.10'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.raw_merchant_code).toBe('85183110');
    expect(r.item.normalized_merchant_code).toBe('85183110');
  });

  it('treats null as absent; both raw and normalized null', () => {
    const r = parseItem(line(null));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('absent');
    expect(r.item.raw_merchant_code).toBeNull();
    expect(r.item.normalized_merchant_code).toBeNull();
  });

  it('treats whitespace-only string as absent', () => {
    const r = parseItem(line('   '));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('absent');
    expect(r.item.normalized_merchant_code).toBeNull();
  });
});
