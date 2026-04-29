import { describe, expect, it } from 'vitest';
import { trimCatalogDashes, trimAlternativeDashes } from './_helpers.js';

describe('trimCatalogDashes', () => {
  it('strips leading dashes-with-spaces (catalog tree depth indicator)', () => {
    expect(trimCatalogDashes('- - Other :')).toBe('Other');
  });

  it('strips leading dashes from Arabic catalog text', () => {
    expect(trimCatalogDashes('- - أحذية رياضية')).toBe('أحذية رياضية');
  });

  it('returns null on null input', () => {
    expect(trimCatalogDashes(null)).toBeNull();
  });

  it('returns null on undefined input', () => {
    expect(trimCatalogDashes(undefined)).toBeNull();
  });

  it('returns null on empty string', () => {
    expect(trimCatalogDashes('')).toBeNull();
  });

  it('returns null on whitespace-only string', () => {
    expect(trimCatalogDashes('   ')).toBeNull();
  });

  it('returns null on dashes-only string (catalog placeholder)', () => {
    expect(trimCatalogDashes('- - -')).toBeNull();
  });

  it('preserves text that has no leading dashes', () => {
    expect(trimCatalogDashes('Cotton t-shirt')).toBe('Cotton t-shirt');
  });

  it('preserves internal dashes — only strips leading runs', () => {
    expect(trimCatalogDashes('- T-shirts and short shirts')).toBe(
      'T-shirts and short shirts',
    );
  });

  it('strips en-dash and em-dash variants', () => {
    expect(trimCatalogDashes('– — Other')).toBe('Other');
  });

  it('strips bullets, dots, and colons in the leading run', () => {
    expect(trimCatalogDashes('· . • : Other')).toBe('Other');
  });

  it('collapses internal whitespace', () => {
    expect(trimCatalogDashes('- -  Cotton    t-shirt')).toBe('Cotton t-shirt');
  });
});

describe('trimAlternativeDashes', () => {
  it('mutates EN+AR descriptions in place across an array', () => {
    const input = [
      { code: '610910000002', description_en: '- - T-shirts of cotton', description_ar: '- - قمصان من قطن', extra: 'kept' },
      { code: '620500000000', description_en: 'Wired handsets', description_ar: null },
    ];
    const out = trimAlternativeDashes(input);
    expect(out).toBe(input); // returns same reference
    expect(input[0]!.description_en).toBe('T-shirts of cotton');
    expect(input[0]!.description_ar).toBe('قمصان من قطن');
    expect(input[0]!.extra).toBe('kept'); // non-description fields untouched
    expect(input[1]!.description_en).toBe('Wired handsets'); // already clean
    expect(input[1]!.description_ar).toBeNull();
  });

  it('handles empty array', () => {
    expect(trimAlternativeDashes([])).toEqual([]);
  });
});
