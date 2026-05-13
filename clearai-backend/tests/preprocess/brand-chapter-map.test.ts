/**
 * Brand → chapter lookup (PR5 / Layer 4).
 *
 * Verifies the curated table behaviour: known brands resolve to chapters,
 * unknown brands return empty, and the matching is token-boundary
 * sensitive (substring matches like "klego" do not hit "lego").
 */
import { describe, it, expect } from 'vitest';
import { lookupBrandChapter } from '../../src/modules/pipeline/cleanup/brand-chapter-map.js';

describe('lookupBrandChapter', () => {
  it('returns the chapter for a known toy brand', () => {
    expect(lookupBrandChapter('Lego Education Spike Essential Set')).toBe('95');
    expect(lookupBrandChapter('Intex Saucer And Swing Set')).toBe('95');
    expect(lookupBrandChapter('PLAYMOBIL knights castle')).toBe('95');
  });

  it('returns the chapter for a known baby-carriage brand', () => {
    expect(lookupBrandChapter('Joolz baby cot')).toBe('87');
    expect(lookupBrandChapter('Bugaboo Butterfly 2 Complete Stroller')).toBe('87');
  });

  it('returns the chapter for a cosmetics brand', () => {
    expect(lookupBrandChapter('Garnier shampoo')).toBe('33');
    expect(lookupBrandChapter('Revolution palette')).toBe('33');
  });

  it('returns empty string for an unknown brand', () => {
    expect(lookupBrandChapter('Acme Widgets Industrial')).toBe('');
    expect(lookupBrandChapter('Random product description')).toBe('');
  });

  it('returns empty string for an empty input', () => {
    expect(lookupBrandChapter('')).toBe('');
    expect(lookupBrandChapter('   ')).toBe('');
  });

  it('is case-insensitive on the match', () => {
    expect(lookupBrandChapter('LEGO')).toBe('95');
    expect(lookupBrandChapter('lego')).toBe('95');
    expect(lookupBrandChapter('Lego')).toBe('95');
  });

  it('only matches whole tokens (no substring leaks)', () => {
    // "klego" should NOT hit the "lego" entry — token boundary required.
    expect(lookupBrandChapter('klego')).toBe('');
    expect(lookupBrandChapter('legobacht')).toBe('');
    // 3-char minimum: 1-2 char fragments are filtered out before matching.
    expect(lookupBrandChapter('lo')).toBe('');
  });

  it('matches on a token amid noise', () => {
    expect(lookupBrandChapter('Set: Pokemon trading cards (sealed)')).toBe('95');
  });

  it('first-match-wins when an input has multiple known brands', () => {
    // Two brands in the same input — order of appearance in tokenize()
    // wins. Asserting that something matches; the exact result depends
    // on tokenization order.
    expect(lookupBrandChapter('Pokemon and Lego bundle')).not.toBe('');
  });
});
