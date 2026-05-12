/**
 * Stage 0a parser merchant-code length classification.
 *
 * Trailing zeros are SEMANTIC granularity indicators, not padding. The
 * parser does not auto-pad. Length policy (relaxed 2026-05-12):
 *   - 12 digits         → twelve_digit
 *   - 6-11 digits       → short_prefix (any subheading-or-deeper granularity)
 *   - 1-5 digits, 13+   → malformed
 *   - null / empty      → absent
 *
 * Pre-relaxation we only accepted exactly {6, 8, 10, 12}. 7/9/11 happen
 * routinely from xlsx scientific-notation autoformat losing a trailing
 * zero, or from broker uploads where a single national-tariff digit
 * gets pasted onto an HS6. Track B's expandWithFallback widens the
 * subtree search to whatever length is supplied.
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

describe('parseItem — merchant code length classification', () => {
  it('classifies 12 digits as twelve_digit', () => {
    const r = parseItem(line('851830000000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('twelve_digit');
    expect(r.item.raw_merchant_code).toBe('851830000000');
  });

  it('classifies 10 digits as short_prefix', () => {
    const r = parseItem(line('8518300000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.raw_merchant_code).toBe('8518300000');
  });

  it('classifies 8 digits as short_prefix', () => {
    const r = parseItem(line('85183000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.raw_merchant_code).toBe('85183000');
  });

  it('classifies 6 digits as short_prefix', () => {
    const r = parseItem(line('851830'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.raw_merchant_code).toBe('851830');
  });

  it('classifies 7 digits as short_prefix (relaxed 2026-05-12)', () => {
    const r = parseItem(line('8518311'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.raw_merchant_code).toBe('8518311');
  });

  it('classifies 9 digits as short_prefix (relaxed 2026-05-12)', () => {
    const r = parseItem(line('851831100'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
  });

  it('classifies 11 digits as short_prefix (relaxed 2026-05-12)', () => {
    const r = parseItem(line('85183110000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
  });

  it('rejects 5 digits as malformed (HS4 or shorter — too coarse for declaration)', () => {
    const r = parseItem(line('85183'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('malformed');
  });

  it('rejects 4 digits as malformed (HS4 heading — too coarse)', () => {
    const r = parseItem(line('8518'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('malformed');
  });

  it('rejects 13 digits as malformed (longer than HS12 — data corruption)', () => {
    const r = parseItem(line('8518311000000'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('malformed');
  });

  it('strips non-digits before classifying ("8518.31.10" → 8 digits → short_prefix)', () => {
    const r = parseItem(line('8518.31.10'));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('short_prefix');
    expect(r.item.raw_merchant_code).toBe('85183110');
  });

  it('treats null as absent', () => {
    const r = parseItem(line(null));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('absent');
    expect(r.item.raw_merchant_code).toBeNull();
  });

  it('treats whitespace-only string as absent', () => {
    const r = parseItem(line('   '));
    if (r.rejected) throw new Error('unexpected reject');
    expect(r.item.merchant_code_state).toBe('absent');
  });

  it('preserves trailing zeros as semantic granularity (851830 ≠ 851830000000)', () => {
    const r6 = parseItem(line('851830'));
    const r12 = parseItem(line('851830000000'));
    if (r6.rejected || r12.rejected) throw new Error('unexpected reject');
    expect(r6.item.raw_merchant_code).toBe('851830');
    expect(r12.item.raw_merchant_code).toBe('851830000000');
    expect(r6.item.merchant_code_state).toBe('short_prefix');
    expect(r12.item.merchant_code_state).toBe('twelve_digit');
  });
});
