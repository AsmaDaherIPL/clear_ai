/**
 * Tests for the deterministic short-circuit in merchant-cleanup.
 *
 * The LLM path is exercised end-to-end via the route smoke tests; here we
 * pin down the rules of `looksClean` so future edits don't accidentally
 * widen or narrow the bypass set without us noticing.
 */
import { describe, expect, it } from 'vitest';
import { looksClean } from './merchant-cleanup.js';

describe('looksClean — deterministic short-circuit', () => {
  it.each([
    'Hair Clip',
    'Coat',
    'Cards',
    'Women Pants',
    'Ceramic Water Cup',
    'Phone Case',
    'Earrings',
    'Sweater',
    'Eyeshadow',
    'Jackets',
    'Dresses',
    '',
    'parcel', // ungrounded but short — cleanup is skipped, route falls through
  ])('treats %s as already-clean (skip LLM)', (input) => {
    expect(looksClean(input)).toBe(true);
  });

  it.each([
    // Long inputs (>4 tokens)
    'Bluetooth over-ear headphones, active noise cancelling',
    'Cotton men\'s long-sleeve T-shirt with logo',
    // ASIN
    'Nike sneakers B0BZ8BGWF8',
    'B0DP3GDTCF', // bare ASIN
    // Mixed alphanumeric model code
    'WH-1000XM5',
    'Arizona BFBC Mocca43', // 3 tokens but the model code Mocca43 trips the rule
    // Marketing punctuation
    'Smartphone (International Version)',
    'Storage rack, plastic, 5 tier',
    // Long input regardless of token count
    'a'.repeat(100),
  ])('routes %s to LLM (not clean)', (input) => {
    expect(looksClean(input)).toBe(false);
  });

  it('treats single common nouns as clean', () => {
    expect(looksClean('Smartphone')).toBe(true);
    expect(looksClean('Headphones')).toBe(true);
  });

  it('strips whitespace before evaluating', () => {
    expect(looksClean('  Hair Clip  ')).toBe(true);
    expect(looksClean('   ')).toBe(true);
  });
});
