/**
 * PR 7 — dedupe union tests (pure function, no mocks).
 */
import { describe, expect, it } from 'vitest';
import { dedupeCandidates } from '../../src/modules/pipeline/v2/retrieve/union.js';
import type { ScoredCandidate } from '../../src/modules/pipeline/v2/types.js';

function c(
  code: string,
  rrf: number,
  arm: ScoredCandidate['source_arm'] = 'merchant_prefix',
): ScoredCandidate {
  return {
    code,
    description_en: `en ${code}`,
    description_ar: null,
    path_en: '',
    path_ar: '',
    rrf_score: rrf,
    bm25_score: null,
    vector_score: null,
    trigram_score: null,
    source_arm: arm,
  };
}

describe('dedupeCandidates', () => {
  it('returns empty array for empty input', () => {
    expect(dedupeCandidates([])).toEqual([]);
  });

  it('passes through unique codes unchanged, sorted by rrf descending', () => {
    const input = [c('a', 0.5), c('b', 0.8), c('c', 0.3)];
    const out = dedupeCandidates(input);
    expect(out.map((x) => x.code)).toEqual(['b', 'a', 'c']);
  });

  it('keeps the highest-scoring entry when same code appears multiple times', () => {
    const input = [c('a', 0.3, 'merchant_prefix'), c('a', 0.8, 'family_chapter'), c('a', 0.5, 'lexical_tokens')];
    const out = dedupeCandidates(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.rrf_score).toBe(0.8);
    expect(out[0]!.source_arm).toBe('family_chapter'); // the winning arm's tag
  });

  it('preserves source_arm tag from the winning entry', () => {
    // merchant arm has lower score; identify-side family arm wins
    const input = [c('847180000000', 0.4, 'merchant_prefix'), c('847180000000', 0.7, 'family_chapter')];
    const out = dedupeCandidates(input);
    expect(out[0]!.source_arm).toBe('family_chapter');
  });

  it('handles 3 arms returning overlapping codes correctly', () => {
    const input = [
      c('a', 0.5, 'merchant_prefix'),
      c('b', 0.6, 'merchant_prefix'),
      c('a', 0.4, 'family_chapter'), // duplicate of a, lower score
      c('c', 0.7, 'family_chapter'),
      c('b', 0.9, 'lexical_tokens'), // duplicate of b, higher score, wins
      c('d', 0.2, 'lexical_tokens'),
    ];
    const out = dedupeCandidates(input);
    expect(out.map((x) => x.code)).toEqual(['b', 'c', 'a', 'd']);
    // b's winning entry came from lexical_tokens (0.9 > 0.6 > 0.4)
    expect(out.find((x) => x.code === 'b')!.source_arm).toBe('lexical_tokens');
    // a's winning entry came from merchant_prefix (0.5 > 0.4)
    expect(out.find((x) => x.code === 'a')!.source_arm).toBe('merchant_prefix');
  });

  it('does not mutate the input array', () => {
    const input = [c('a', 0.5), c('a', 0.8)];
    const inputCopy = input.map((x) => ({ ...x }));
    dedupeCandidates(input);
    expect(input).toEqual(inputCopy);
  });

  it('is stable: ties broken by first-occurrence', () => {
    const input = [
      c('a', 0.5, 'merchant_prefix'),
      c('a', 0.5, 'family_chapter'), // same score, later → loses
    ];
    const out = dedupeCandidates(input);
    expect(out[0]!.source_arm).toBe('merchant_prefix');
  });
});
