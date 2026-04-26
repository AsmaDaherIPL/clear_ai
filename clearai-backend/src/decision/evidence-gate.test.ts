import { describe, it, expect } from 'vitest';
import { evaluateGate } from './evidence-gate.js';
import type { Candidate } from '../retrieval/retrieve.js';

function cand(code: string, score: number): Candidate {
  return {
    code,
    description_en: null,
    description_ar: null,
    parent10: code.slice(0, 10),
    vec_rank: 1,
    bm25_rank: 1,
    trgm_rank: 1,
    vec_score: score,
    bm25_score: score,
    trgm_score: score,
    rrf_score: score,
  };
}

describe('evaluateGate', () => {
  it('fails on empty candidates', () => {
    const r = evaluateGate([], { minScore: 0.3, minGap: 0.04 });
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('invalid_prefix');
  });

  it('fails when top score below MIN_SCORE', () => {
    const r = evaluateGate([cand('1', 0.2), cand('2', 0.1)], { minScore: 0.3, minGap: 0.04 });
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('weak_retrieval');
  });

  it('fails when top1-top2 gap below MIN_GAP', () => {
    const r = evaluateGate([cand('1', 0.5), cand('2', 0.49)], { minScore: 0.3, minGap: 0.04 });
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('ambiguous_top_candidates');
  });

  it('passes on a clear winner', () => {
    const r = evaluateGate([cand('1', 0.8), cand('2', 0.5)], { minScore: 0.3, minGap: 0.04 });
    expect(r.passed).toBe(true);
    if (r.passed) {
      expect(r.topRetrievalScore).toBeCloseTo(0.8);
      expect(r.top2Gap).toBeCloseTo(0.3);
    }
  });
});
