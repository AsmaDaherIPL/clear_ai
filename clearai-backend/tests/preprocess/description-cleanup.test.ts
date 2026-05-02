/**
 * Tests for the deterministic short-circuit + return-shape contract in
 * description-cleanup. The LLM path is exercised end-to-end via the route
 * smoke tests; here we pin down:
 *   • `looksClean` rules so future edits don't accidentally widen or narrow
 *     the bypass set without us noticing
 *   • the noun_grounded / typo_corrections / multi_product invariants on
 *     the skipped-clean fast path (the LLM-emitted versions are tested
 *     end-to-end where the real Haiku call provides them)
 */
import { describe, expect, it } from 'vitest';
import { looksClean, cleanDescription } from '../../src/preprocess/description-cleanup.js';

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
    // Short model-suffix codes ending in a digit (brand-shaped inputs)
    'Unicskin Body Slim X4', // "X4" is a 2-char product variant suffix
    'Samsung Galaxy A14',    // "A14" is a model designator
    'Philips Avent SCF819',  // "SCF819" is a 6-char model code
    // Marketing punctuation
    'Smartphone (International Version)',
    'Storage rack, plastic, 5 tier',
    // Multi-product inputs — must reach the LLM so it can return kind=multi_product.
    'Arizona BFBC Mocca43, Boston Wire Buckle Taupe39',
    'iPhone 15 case + screen protector',
    'shoe cleaner and leather polish',
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

describe('cleanDescription — skipped_clean shape contract', () => {
  // No DB / no LLM — the looksClean fast path is pure. We can therefore
  // safely assert the full DescriptionCleanupResult shape here without a
  // mocked client.
  it('returns nounGrounded=true and empty typoCorrections on a clean noun', async () => {
    const r = await cleanDescription('Hair Clip');
    expect(r.invoked).toBe('skipped_clean');
    expect(r.kind).toBe('product');
    expect(r.effective).toBe('Hair Clip');
    expect(r.nounGrounded).toBe(true);
    expect(r.typoCorrections).toEqual([]);
    expect(r.products).toEqual([]);
    expect(r.attributes).toEqual([]);
  });

  it('returns nounGrounded=true on whitespace-trimmed clean input', async () => {
    const r = await cleanDescription('  Cards  ');
    expect(r.invoked).toBe('skipped_clean');
    expect(r.effective).toBe('Cards');
    expect(r.nounGrounded).toBe(true);
  });
});
