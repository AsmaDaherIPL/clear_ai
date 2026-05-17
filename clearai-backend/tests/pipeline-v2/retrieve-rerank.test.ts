/**
 * PR 8 — reranker v1 tests.
 */
import { describe, expect, it } from 'vitest';
import { rerank, RERANK_CAP } from '../../src/modules/pipeline/v2/retrieve/rerank.js';
import type {
  IdentifyCallTrace,
  IdentifyResult,
  ScoredCandidate,
} from '../../src/modules/pipeline/v2/types.js';

const fastTrace: IdentifyCallTrace = {
  pass: 'fast',
  llm_called: true,
  latency_ms: 2000,
  model: 'mock-sonnet',
  status: 'ok',
  web_search_used: false,
  evidence_mismatch: false,
};

function id(opts: { family?: string | null; tokens?: string[] } = {}): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical: 'cotton t-shirt',
    family_chapter: 'family' in opts ? opts.family ?? null : '61',
    identity_tokens: opts.tokens ?? [],
    confidence: 0.9,
    evidence: 'world_knowledge',
    trace: fastTrace,
  };
}

function c(
  code: string,
  rrf: number,
  arm: ScoredCandidate['source_arm'] = 'merchant_prefix',
  desc_en: string | null = null,
  desc_ar: string | null = null,
): ScoredCandidate {
  return {
    code,
    description_en: desc_en,
    description_ar: desc_ar,
    path_en: '',
    path_ar: '',
    rrf_score: rrf,
    bm25_score: null,
    vector_score: null,
    trigram_score: null,
    source_arm: arm,
  };
}

describe('rerank — base behavior', () => {
  it('returns empty array for empty input', () => {
    expect(rerank([], id())).toEqual([]);
  });

  it('respects cap = RERANK_CAP (8)', () => {
    const lots = Array.from({ length: 20 }, (_, i) => c(`61091000000${i}`.slice(-12), 0.5 - i * 0.01));
    const out = rerank(lots, id());
    expect(out).toHaveLength(RERANK_CAP);
  });

  it('honors caller-supplied cap', () => {
    const lots = Array.from({ length: 10 }, (_, i) => c(`61091000000${i}`.slice(-12), 0.5 - i * 0.01));
    const out = rerank(lots, id(), 3);
    expect(out).toHaveLength(3);
  });

  it('sorts descending by rerank_score', () => {
    const input = [c('a', 0.3), c('b', 0.8), c('c', 0.5)];
    const out = rerank(input, id({ family: null }));
    // No chapter agreement (family=null), no overlap, all merchant_prefix arm
    // → rerank_score = rrf_score + 0.03 (arm boost) for each
    expect(out.map((x) => x.code)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate input', () => {
    const input = [c('a', 0.5)];
    const copy = input.map((x) => ({ ...x }));
    rerank(input, id());
    expect(input).toEqual(copy);
  });
});

describe('rerank — chapter_agreement feature', () => {
  it('boosts chapter-matching candidate over equal-rrf non-match', () => {
    const input = [
      c('610910000000', 0.5), // chapter 61 — match
      c('853110000000', 0.5), // chapter 85 — no match
    ];
    const out = rerank(input, id({ family: '61' }));
    expect(out[0]!.code).toBe('610910000000');
    expect(out[0]!.rerank_features.chapter_agreement).toBe(true);
    expect(out[1]!.rerank_features.chapter_agreement).toBe(false);
  });

  it('chapter_agreement requires family_chapter to be set', () => {
    const input = [c('610910000000', 0.5), c('853110000000', 0.5)];
    const out = rerank(input, id({ family: null }));
    // Neither candidate gets chapter_agreement
    out.forEach((cand) => expect(cand.rerank_features.chapter_agreement).toBe(false));
  });
});

describe('rerank — identity_token_overlap feature', () => {
  it('counts substring matches in description_en', () => {
    const input = [
      c('a', 0.5, 'merchant_prefix', 'cotton t-shirt with maxhub logo'),
      c('b', 0.5, 'merchant_prefix', 'plain cotton t-shirt'),
    ];
    const out = rerank(input, id({ tokens: ['maxhub'] }));
    expect(out[0]!.code).toBe('a'); // boosted by token match
    expect(out[0]!.rerank_features.identity_token_overlap_count).toBe(1);
    expect(out[1]!.rerank_features.identity_token_overlap_count).toBe(0);
  });

  it('counts matches in description_ar (no lowercasing)', () => {
    const input = [
      c('a', 0.5, 'merchant_prefix', null, 'كتاب: مزرعة الحيوان'),
      c('b', 0.5, 'merchant_prefix', 'another desc', null),
    ];
    const out = rerank(input, id({ tokens: ['مزرعة الحيوان'] }));
    expect(out[0]!.code).toBe('a');
    expect(out[0]!.rerank_features.identity_token_overlap_count).toBe(1);
  });

  it('counts each token at most once even when present in both languages', () => {
    const input = [
      c('a', 0.5, 'merchant_prefix', 'panthenol cream', 'باthenol kram'),
    ];
    const out = rerank(input, id({ tokens: ['panthenol'] }));
    expect(out[0]!.rerank_features.identity_token_overlap_count).toBe(1);
  });

  it('caps the boost at +0.20 (4 tokens × 0.05)', () => {
    const input = [
      c('a', 0.0, 'family_chapter', 'all five tokens: alpha beta gamma delta epsilon'),
    ];
    const out = rerank(input, id({ family: null, tokens: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] }));
    expect(out[0]!.rerank_features.identity_token_overlap_count).toBe(5);
    // Score = 0 (rrf) + 0 (no chapter agree) + 0.20 (capped) + 0 (family_chapter arm) = 0.20
    expect(out[0]!.rerank_score).toBeCloseTo(0.20, 5);
  });

  it('ignores empty token strings', () => {
    const input = [c('a', 0.5, 'merchant_prefix', 'desc with stuff')];
    const out = rerank(input, id({ tokens: ['', '  ', 'stuff'] }));
    expect(out[0]!.rerank_features.identity_token_overlap_count).toBe(1);
  });

  it('case-insensitive for English description', () => {
    const input = [c('a', 0.5, 'merchant_prefix', 'COTTON T-SHIRT')];
    const out = rerank(input, id({ tokens: ['cotton'] }));
    expect(out[0]!.rerank_features.identity_token_overlap_count).toBe(1);
  });
});

describe('rerank — arm_boost feature', () => {
  it('merchant_prefix arm gets +0.03', () => {
    const input = [c('a', 0.5, 'merchant_prefix')];
    const out = rerank(input, id({ family: null }));
    expect(out[0]!.rerank_features.arm_boost).toBe(0.03);
    expect(out[0]!.rerank_score).toBeCloseTo(0.53, 5);
  });

  it('lexical_tokens arm gets +0.02', () => {
    const input = [c('a', 0.5, 'lexical_tokens')];
    const out = rerank(input, id({ family: null }));
    expect(out[0]!.rerank_features.arm_boost).toBe(0.02);
  });

  it('family_chapter arm gets +0.00 (neutral)', () => {
    const input = [c('a', 0.5, 'family_chapter')];
    const out = rerank(input, id({ family: null }));
    expect(out[0]!.rerank_features.arm_boost).toBe(0.0);
  });

  it('unconstrained arm gets -0.02 penalty', () => {
    const input = [c('a', 0.5, 'unconstrained')];
    const out = rerank(input, id({ family: null }));
    expect(out[0]!.rerank_features.arm_boost).toBe(-0.02);
  });
});

describe('rerank — combined features', () => {
  it('chapter agreement + token overlap + arm boost stack additively', () => {
    const input = [c('610910000000', 0.5, 'merchant_prefix', 'cotton t-shirt with logo')];
    const out = rerank(input, id({ family: '61', tokens: ['cotton'] }));
    // Score = 0.5 (rrf) + 0.10 (chapter) + 0.05 (1 token) + 0.03 (merchant arm) = 0.68
    expect(out[0]!.rerank_score).toBeCloseTo(0.68, 5);
  });

  it('determinism: same input → same output', () => {
    const input = [c('a', 0.5), c('b', 0.6), c('c', 0.4)];
    const r1 = rerank(input, id({ family: '61' }));
    const r2 = rerank(input, id({ family: '61' }));
    expect(r1).toEqual(r2);
  });
});

describe('rerank — uninformative + multi_product identify', () => {
  it('uninformative identify: no chapter agreement boost, no token boost', () => {
    const input = [c('a', 0.5, 'merchant_prefix', 'something')];
    const uninf: IdentifyResult = {
      kind: 'uninformative',
      cause: 'genuine',
      reason: 'unrecognised',
      trace: fastTrace,
    };
    const out = rerank(input, uninf);
    expect(out[0]!.rerank_features.chapter_agreement).toBe(false);
    expect(out[0]!.rerank_features.identity_token_overlap_count).toBe(0);
  });
});
