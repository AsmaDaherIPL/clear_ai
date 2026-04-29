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

  it('fails when top1-top2 gap below MIN_GAP and headings differ', () => {
    // 1509.20.xx (olive oil) vs 1510.10.xx (other oils) — different
    // HS-4 headings → genuinely ambiguous, gate refuses.
    const r = evaluateGate(
      [cand('150920000000', 0.5), cand('151010000000', 0.49)],
      { minScore: 0.3, minGap: 0.04 },
    );
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('ambiguous_top_candidates');
  });

  it('passes when top1-top2 gap is small but they share a heading family', () => {
    // The olive-oil case: 1509.20 / 1509.40 / 1509.30 — all extra
    // virgin / virgin / pomace under heading 1509. The picker is the
    // right tool to disambiguate within a narrow family; we shouldn't
    // refuse and fall back to heading-padded.
    const r = evaluateGate(
      [
        cand('150920000000', 1.0),
        cand('150940000000', 0.99),
        cand('150930000000', 0.98),
      ],
      { minScore: 0.3, minGap: 0.04 },
    );
    expect(r.passed).toBe(true);
  });

  it('passes when top-2 share a heading even if top-3 wanders', () => {
    // The face-mask case: top-1 4818.90 (medical) and top-2 4818.90
    // (general) tied at heading 4818, but top-3 is 6307.90 (textile
    // dust masks). The strict 3-row rule used to refuse this; the
    // top-2 rule passes it because the actual ambiguity (top-1 vs
    // top-2) is within one heading and the picker can resolve it.
    const r = evaluateGate(
      [
        cand('481890000001', 1.0),
        cand('481890000002', 0.9948),
        cand('630790970002', 0.9901),
        cand('630790970003', 0.9797),
      ],
      { minScore: 0.3, minGap: 0.04 },
    );
    expect(r.passed).toBe(true);
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
