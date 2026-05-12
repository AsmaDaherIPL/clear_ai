import { describe, it, expect } from 'vitest';
import { filterByChapterCoherence } from '../../src/modules/pipeline/classify/description-classifier/picker/chapter-coherence-filter.js';
import type { Candidate } from '../../src/inference/retrieval/retrieve.js';

function cand(code: string, score = 0.02): Candidate {
  return {
    code,
    description_en: `leaf ${code}`,
    description_ar: null,
    rrf_score: score,
  } as Candidate;
}

describe('filterByChapterCoherence', () => {
  it('drops impossible chapters when description has a strong keyword', () => {
    // Description "wireless headphones" → inferred chapter 85.
    // Candidates span 85 (real), 29 (vitamin B6), 04 (honey), 09 (vanilla).
    const result = filterByChapterCoherence(
      [
        cand('851830000000'), // ch 85 — keep
        cand('851762900009'), // ch 85 — keep
        cand('851830900003'), // ch 85 — keep
        cand('293625900000'), // ch 29 — drop
        cand('040900000000'), // ch 04 — drop
        cand('090500000000'), // ch 09 — drop
      ],
      'wireless headphones',
    );
    expect(result.matchedChapters).toEqual(['85']);
    expect(result.aborted).toBe(false);
    expect(result.filtered.map((c) => c.code.slice(0, 2))).toEqual(['85', '85', '85']);
  });

  it('is a no-op when no keyword matches the description', () => {
    const candidates = [
      cand('851830000000'),
      cand('420212200006'),
      cand('293625900000'),
    ];
    const result = filterByChapterCoherence(candidates, 'asdfqwer random gibberish');
    expect(result.matchedChapters).toEqual([]);
    expect(result.aborted).toBe(false);
    expect(result.filtered).toEqual(candidates); // unchanged
  });

  it('aborts when filter would drop below MIN_CANDIDATES (safety net)', () => {
    // "headphones" → chapter 85. But none of these are chapter 85, so
    // filter would drop to 0. Must abort and return the original set.
    const candidates = [
      cand('420212200006'), // ch 42
      cand('293625900000'), // ch 29
    ];
    const result = filterByChapterCoherence(candidates, 'wireless headphones');
    expect(result.matchedChapters).toEqual(['85']);
    expect(result.aborted).toBe(true);
    expect(result.filtered).toEqual(candidates); // returned unchanged
  });

  it('aborts when filter would drop to exactly 1 or 2 candidates', () => {
    // 2 keep, 4 drop → below MIN_CANDIDATES (3) → abort
    const candidates = [
      cand('851830000000'),
      cand('851762900009'),
      cand('293625900000'),
      cand('040900000000'),
      cand('090500000000'),
      cand('290110000000'),
    ];
    const result = filterByChapterCoherence(candidates, 'wireless headphones');
    expect(result.aborted).toBe(true);
    expect(result.filtered).toEqual(candidates);
  });

  it('keeps the filter when result has at least MIN_CANDIDATES (3)', () => {
    const candidates = [
      cand('851830000000'),
      cand('851762900009'),
      cand('851830900003'),
      cand('293625900000'), // drop
      cand('040900000000'), // drop
    ];
    const result = filterByChapterCoherence(candidates, 'wireless headphones');
    expect(result.aborted).toBe(false);
    expect(result.filtered).toHaveLength(3);
  });

  it('handles Arabic keywords', () => {
    const candidates = [
      cand('851830000000'), // ch 85
      cand('851762900009'), // ch 85
      cand('851830900003'), // ch 85
      cand('420212200006'), // ch 42 — drop
      cand('293625900000'), // ch 29 — drop
    ];
    const result = filterByChapterCoherence(candidates, 'سماعات راس لاسلكية');
    expect(result.matchedChapters).toEqual(['85']);
    expect(result.aborted).toBe(false);
    expect(result.filtered).toHaveLength(3);
  });

  it('keeps multi-chapter keyword candidates from either chapter', () => {
    // "hoodie" / "jacket" → chapters 61 OR 62 both valid (knitted vs woven)
    const candidates = [
      cand('611030000000'), // ch 61 — keep
      cand('620120000000'), // ch 62 — keep
      cand('620330000000'), // ch 62 — keep
      cand('510110000000'), // ch 51 — drop (raw wool)
      cand('280400000000'), // ch 28 — drop
    ];
    const result = filterByChapterCoherence(candidates, 'cotton jacket');
    expect(result.matchedChapters.sort()).toEqual(['61', '62']);
    expect(result.aborted).toBe(false);
    expect(result.filtered).toHaveLength(3);
  });

  it('does NOT trigger on substring-only matches', () => {
    // "manure" should not match the "manual" pattern (if there were one).
    // Today we don't have a "manual" entry, but verify the principle on
    // a real word boundary case: "perfume" should NOT match "perfumes"
    // accidentally if we had it. Use "bookworm" as a non-match for "book".
    const candidates = [
      cand('851830000000'),
      cand('420212200006'),
      cand('293625900000'),
    ];
    // "bookworm" — we have /\bbook\b/ as a keyword. Word boundary
    // means "bookworm" does NOT match "book".
    const result = filterByChapterCoherence(candidates, 'bookworm enthusiast');
    expect(result.matchedChapters).toEqual([]); // no match
    expect(result.filtered).toEqual(candidates);
  });

  it('records dropped candidate codes via the picker wrapper (forensic surface)', () => {
    // Direct API exposes filtered + matchedChapters + aborted.
    // The picker wrapper computes dropped_codes from the diff. Verify
    // the diff math is straightforward:
    const candidates = [
      cand('851830000000'),
      cand('851762900009'),
      cand('851830900003'),
      cand('293625900000'),
    ];
    const result = filterByChapterCoherence(candidates, 'wireless headphones');
    expect(result.filtered.map((c) => c.code)).toEqual([
      '851830000000',
      '851762900009',
      '851830900003',
    ]);
    // The wrapper's dropped_codes diff would be ['293625900000'] —
    // verified at the picker.ts level, not in this unit test.
  });
});
