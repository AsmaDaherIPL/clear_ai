/**
 * PR 7 — multi-arm retrieval tests.
 *
 * Mocks retrieveCandidates at the module boundary. Asserts:
 *  - Each arm fires retrieveCandidates with the correct options
 *  - escalate arms produce zero candidates (skipped, not called)
 *  - lexical_tokens arm uses joined tokens as the query and lexical weights
 *  - All arms execute in parallel (Promise.all)
 *  - per_arm_counts is accurate
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/retrieval/retrieve.js', () => ({
  retrieveCandidates: vi.fn(),
}));

import { runMultiArmRetrieval } from '../../src/modules/pipeline/v2/retrieve/multi-arm.js';
import { retrieveCandidates } from '../../src/inference/retrieval/retrieve.js';
import type { ScopeSelection } from '../../src/modules/pipeline/v2/types.js';
import type { Candidate } from '../../src/inference/retrieval/retrieve.js';

const mockRetrieve = vi.mocked(retrieveCandidates);

function legacyCandidate(code: string, rrf: number): Candidate {
  return {
    code,
    description_en: `en ${code}`,
    description_ar: null,
    parent10: code.slice(0, 10),
    path_en: '',
    path_ar: '',
    path_codes: [],
    vec_rank: 1,
    bm25_rank: null,
    trgm_rank: null,
    vec_score: null,
    bm25_score: null,
    trgm_score: null,
    rrf_score: rrf,
  };
}

beforeEach(() => mockRetrieve.mockReset());

describe('runMultiArmRetrieval — single arm (primary only)', () => {
  it('merchant_prefix primary calls retrieveCandidates with prefixFilter', async () => {
    mockRetrieve.mockResolvedValueOnce([legacyCandidate('610910000000', 0.5)]);
    const scope: ScopeSelection = {
      primary: { kind: 'merchant_prefix', prefix: '610910', source: 'merchant_active' },
      secondaries: [],
      audit_flags: [],
    };
    const r = await runMultiArmRetrieval(scope, 'cotton t-shirt');
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    const opts = mockRetrieve.mock.calls[0]![1];
    expect(opts).toMatchObject({ prefixFilter: '610910', topK: 12 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.source_arm).toBe('merchant_prefix');
    expect(r.per_arm_counts.merchant_prefix).toBe(1);
  });

  it('family_chapter primary calls with chapter as prefixFilter', async () => {
    mockRetrieve.mockResolvedValueOnce([legacyCandidate('852852000000', 0.7)]);
    const scope: ScopeSelection = {
      primary: { kind: 'family_chapter', chapter: '85', source: 'identify' },
      secondaries: [],
      audit_flags: [],
    };
    await runMultiArmRetrieval(scope, 'flat panel display');
    expect(mockRetrieve.mock.calls[0]![1]).toMatchObject({ prefixFilter: '85' });
  });

  it('unconstrained primary calls without prefixFilter', async () => {
    mockRetrieve.mockResolvedValueOnce([]);
    const scope: ScopeSelection = {
      primary: { kind: 'unconstrained', reason: 'composite_product' },
      secondaries: [],
      audit_flags: [],
    };
    await runMultiArmRetrieval(scope, 'tumbler set');
    const opts = mockRetrieve.mock.calls[0]![1];
    expect(opts.prefixFilter).toBeUndefined();
  });

  it('escalate primary skips retrieval entirely', async () => {
    const scope: ScopeSelection = {
      primary: { kind: 'escalate', reason: 'identify_multi_product' },
      secondaries: [],
      audit_flags: [],
    };
    const r = await runMultiArmRetrieval(scope, 'multi');
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(r.candidates).toEqual([]);
  });
});

describe('runMultiArmRetrieval — multi-arm', () => {
  it('runs primary + 2 secondaries in parallel and tags each correctly', async () => {
    mockRetrieve
      .mockResolvedValueOnce([legacyCandidate('610910000000', 0.4)]) // merchant_prefix
      .mockResolvedValueOnce([legacyCandidate('852852000000', 0.8)]) // family_chapter
      .mockResolvedValueOnce([legacyCandidate('850880000000', 0.6)]); // lexical_tokens

    const scope: ScopeSelection = {
      primary: { kind: 'merchant_prefix', prefix: '610910', source: 'merchant_active' },
      secondaries: [
        { kind: 'family_chapter', chapter: '85', source: 'identify' },
        { kind: 'lexical_tokens', tokens: ['vacuum', 'cleaner'] },
      ],
      audit_flags: ['merchant_chapter_disagreement'],
    };
    const r = await runMultiArmRetrieval(scope, 'vacuum cleaner');

    expect(mockRetrieve).toHaveBeenCalledTimes(3);
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates.find((c) => c.code === '610910000000')!.source_arm).toBe('merchant_prefix');
    expect(r.candidates.find((c) => c.code === '852852000000')!.source_arm).toBe('family_chapter');
    expect(r.candidates.find((c) => c.code === '850880000000')!.source_arm).toBe('lexical_tokens');
    expect(r.per_arm_counts).toEqual({
      merchant_prefix: 1,
      family_chapter: 1,
      lexical_tokens: 1,
    });
  });

  it('lexical_tokens arm uses joined tokens as query AND lexical weights', async () => {
    mockRetrieve
      .mockResolvedValueOnce([]) // primary
      .mockResolvedValueOnce([]); // lexical

    const scope: ScopeSelection = {
      primary: { kind: 'merchant_prefix', prefix: '85', source: 'merchant_active' },
      secondaries: [{ kind: 'lexical_tokens', tokens: ['maxhub', 'IFP', 'interactive flat panel'] }],
      audit_flags: [],
    };
    await runMultiArmRetrieval(scope, 'something');

    // Second call is the lexical arm
    const lexicalCall = mockRetrieve.mock.calls[1]!;
    const lexicalQuery = lexicalCall[0];
    expect(lexicalQuery).toBe('maxhub IFP interactive flat panel');

    const opts = lexicalCall[1];
    expect(opts.vecWeight).toBe(0.3);
    expect(opts.bm25Weight).toBe(2.0);
    expect(opts.trgmWeight).toBe(0.5);
    // No prefixFilter on lexical arm
    expect(opts.prefixFilter).toBeUndefined();
  });

  it('lexical_tokens arm with empty token list returns 0 without calling retrieve', async () => {
    mockRetrieve.mockResolvedValueOnce([]); // primary

    const scope: ScopeSelection = {
      primary: { kind: 'merchant_prefix', prefix: '85', source: 'merchant_active' },
      secondaries: [{ kind: 'lexical_tokens', tokens: [] }],
      audit_flags: [],
    };
    const r = await runMultiArmRetrieval(scope, 'q');

    // Only primary call should have happened
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(r.per_arm_counts.lexical_tokens).toBe(0);
  });

  it('aggregates per_arm_counts across multiple retrievals', async () => {
    mockRetrieve
      .mockResolvedValueOnce([legacyCandidate('a', 0.5), legacyCandidate('b', 0.4)])
      .mockResolvedValueOnce([legacyCandidate('c', 0.6)]);

    const scope: ScopeSelection = {
      primary: { kind: 'merchant_prefix', prefix: '85', source: 'merchant_active' },
      secondaries: [{ kind: 'family_chapter', chapter: '85', source: 'identify' }],
      audit_flags: [],
    };
    const r = await runMultiArmRetrieval(scope, 'q');
    expect(r.per_arm_counts.merchant_prefix).toBe(2);
    expect(r.per_arm_counts.family_chapter).toBe(1);
  });
});
