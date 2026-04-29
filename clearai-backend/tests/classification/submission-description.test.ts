/**
 * Unit tests for submission-description.
 *
 * Pins down the deterministic helpers (Arabic normalisation, distinctness
 * check, prefix-mutation fallback) so prompt edits or LLM behaviour drift
 * don't silently change the contract. The end-to-end LLM path is exercised
 * via route smoke tests with SUBMISSION_DESC_ENABLED=1.
 */
import { describe, expect, it } from 'vitest';
import { __test__ } from '../../src/classification/submission-description.js';

const { normalizeAr, passesDistinctnessCheck, buildFallback } = __test__;

describe('normalizeAr', () => {
  it('strips whitespace and trims', () => {
    expect(normalizeAr('  سماعات لاسلكية  ')).toBe('سماعات لاسلكية');
  });

  it('strips Arabic diacritics (تشكيل)', () => {
    // كَلِمَةٌ with diacritics → كلمة without
    expect(normalizeAr('كَلِمَةٌ')).toBe('كلمة');
  });

  it('strips catalog tree-formatting prefixes/suffixes', () => {
    expect(normalizeAr(' - - من قطن')).toBe('من قطن');
    expect(normalizeAr('- - - أحذية رياضية - -')).toBe('أحذية رياضية');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(normalizeAr('')).toBe('');
    expect(normalizeAr('   ')).toBe('');
  });

  it('collapses internal whitespace runs', () => {
    expect(normalizeAr('سماعات   لاسلكية')).toBe('سماعات لاسلكية');
  });
});

describe('passesDistinctnessCheck', () => {
  it('returns true when there is no catalog AR to compare against', () => {
    expect(passesDistinctnessCheck('any', null)).toBe(true);
  });

  it('returns false on exact match (post-normalisation)', () => {
    expect(passesDistinctnessCheck('سماعات لاسلكية', 'سماعات لاسلكية')).toBe(false);
    expect(passesDistinctnessCheck('  سماعات لاسلكية  ', 'سماعات لاسلكية')).toBe(false);
    // Diacritics + tree-formatting prefix should still normalise to a match
    expect(passesDistinctnessCheck('- - سماعات لاسلكية', 'سماعات لاسلكية')).toBe(false);
  });

  it('returns true when a single word is added', () => {
    expect(passesDistinctnessCheck('سماعات بلوتوث لاسلكية', 'سماعات لاسلكية')).toBe(true);
  });

  it('returns true when word order changes', () => {
    expect(passesDistinctnessCheck('لاسلكية سماعات', 'سماعات لاسلكية')).toBe(true);
  });

  it('returns false on empty generation', () => {
    expect(passesDistinctnessCheck('', 'سماعات لاسلكية')).toBe(false);
  });
});

describe('buildFallback', () => {
  it('builds a prefix-mutated AR string from a known-attribute word', () => {
    const fb = buildFallback('bluetooth wireless headphones', 'سماعات لاسلكية');
    // 'bluetooth' is in the TRANSLIT map → بلوتوث
    expect(fb.descriptionAr).toContain('بلوتوث');
    expect(fb.descriptionAr).not.toBe('سماعات لاسلكية'); // distinct from catalog
  });

  it('falls back to the latin word when no transliteration is known', () => {
    const fb = buildFallback('zorblax gizmo', 'منتج');
    // No mapping for zorblax → ship the latin token. Distinctness is what
    // matters; broker will edit. Better than blank.
    expect(fb.descriptionAr.length).toBeGreaterThan(0);
    expect(fb.descriptionEn.length).toBeGreaterThan(0);
  });

  it('handles null catalog AR by using a generic Arabic placeholder', () => {
    const fb = buildFallback('cotton shirt', null);
    expect(fb.descriptionAr.length).toBeGreaterThan(0);
  });

  it('produces a distinct result vs the catalog (post-normalisation)', () => {
    const cat = 'سماعات لاسلكية';
    const fb = buildFallback('bluetooth headphones', cat);
    expect(passesDistinctnessCheck(fb.descriptionAr, cat)).toBe(true);
  });
});
