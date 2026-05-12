import { describe, it, expect } from 'vitest';
import { evaluateGate } from '../../src/modules/pipeline/classify/description-classifier/threshold/evidence-gate.js';
import type { Candidate } from '../../src/inference/retrieval/retrieve.js';

function cand(code: string, score: number): Candidate {
  return {
    code,
    description_en: null,
    description_ar: null,
    parent10: code.slice(0, 10),
    path_en: '',
    path_ar: '',
    path_codes: [],
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

  it('passes when gap is small and top-K spans unrelated chapters (multi-token)', () => {
    // Gap-based refusal was dropped: with the post-Plan-B retrieval
    // distribution, top-1/top-2 deltas of 0.01 are normal even within
    // a coherent product family. The picker has no_fit as its own
    // refusal — let it decide.
    const r = evaluateGate(
      [
        cand('150920000000', 0.5),
        cand('420310000000', 0.49),
        cand('850440000000', 0.48),
      ],
      { minScore: 0.3 },
    );
    expect(r.passed).toBe(true);
  });

  it('passes when top-3 share one chapter despite differing HS-4 headings', () => {
    // The olive-oil family case: 1509.20 (extra virgin) + 1510.10
    // (other oils) + 1509.40 — different HS-4 headings but all under
    // chapter 15 (animal/vegetable fats). Coherent product domain →
    // picker disambiguates rather than the gate refusing.
    const r = evaluateGate(
      [
        cand('150920000000', 0.5),
        cand('151010000000', 0.49),
        cand('150940000000', 0.48),
      ],
      { minScore: 0.3, minGap: 0.04 },
    );
    expect(r.passed).toBe(true);
  });

  it('passes when top-3 straddles an adjacent garment chapter pair (61+62)', () => {
    // The white-tshirt-men-long-sleeve case: top-1 6205 woven shirt,
    // top-2 6109 knit t-shirt with sleeves, top-3 6205 plush. Two
    // adjacent garment chapters → picker disambiguates knit vs woven.
    const r = evaluateGate(
      [
        cand('620500000000', 0.041),
        cand('610990000005', 0.040),
        cand('620590000002', 0.039),
      ],
      { minScore: 0.02, minGap: 0.003 },
    );
    expect(r.passed).toBe(true);
  });

  it('passes when multi-token input retrieves across unrelated chapters (picker decides)', () => {
    // The thin-input chapter-spread guard only fires for ≤1 token
    // inputs. Multi-token retrieval that lands in unrelated chapters
    // hands the call to the picker, which can return no_fit.
    const r = evaluateGate(
      [
        cand('150920000000', 0.041),
        cand('800700000000', 0.040),
        cand('610990000005', 0.039),
      ],
      { minScore: 0.02 },
    );
    expect(r.passed).toBe(true);
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

  describe('thin-input refusal', () => {
    it('refuses single-token input when retrieval spans 3+ chapters', () => {
      // The "books" case: rrf=1.0 winner under chapter 49, but top-5
      // spans chapters 49 (printed books), 48 (notebooks), 85 (e-books)
      // — three chapters in a one-word query is illusory confidence.
      const r = evaluateGate(
        [
          cand('490520000000', 1.0),
          cand('854370900012', 0.99),
          cand('482010000005', 0.97),
          cand('490700800000', 0.83),
          cand('490199300000', 0.77),
        ],
        { minScore: 0.3, minGap: 0.04 },
        'books',
      );
      expect(r.passed).toBe(false);
      if (!r.passed) expect(r.reason).toBe('ambiguous_top_candidates');
    });

    it('passes single-token input when retrieval is family-coherent (≤2 chapters)', () => {
      // The "tshirt" case: top-5 all under chapters 61 + 62 (knitted +
      // woven garments) — same kind of product, just material variants.
      // Two chapters is normal; we only refuse on 3+.
      const r = evaluateGate(
        [
          cand('610910000002', 1.0),
          cand('620500000000', 0.96),
          cand('610910000001', 0.95),
          cand('610690000001', 0.88),
          cand('620590000001', 0.85),
        ],
        { minScore: 0.3, minGap: 0.04 },
        'tshirt',
      );
      expect(r.passed).toBe(true);
    });

    it('does not refuse on multi-token input even if chapters spread', () => {
      // "mens cotton t-shirt" (3 tokens) with the same chapter spread
      // is a normal classification — retrieval just casts a wider net,
      // and the picker is the right tool to disambiguate. Thin-input
      // rule does NOT fire on multi-token input.
      const r = evaluateGate(
        [
          cand('490520000000', 1.0),
          cand('854370900012', 0.99),
          cand('482010000005', 0.97),
        ],
        { minScore: 0.3 },
        'mens cotton t-shirt',
      );
      expect(r.passed).toBe(true);
    });

    it('skips the thin-input check when effectiveDescription is omitted', () => {
      // Backwards compat: expand/boost call without the third arg.
      // The thin-input check must not fire — they pass score/gap normally.
      const r = evaluateGate(
        [cand('490520000000', 1.0), cand('854370900012', 0.5)],
        { minScore: 0.3, minGap: 0.04 },
      );
      expect(r.passed).toBe(true);
    });
  });
});
