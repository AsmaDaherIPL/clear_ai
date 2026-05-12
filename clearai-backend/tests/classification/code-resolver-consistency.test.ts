/**
 * PR 5: Track B subtree-anchored retrieval + consistency_verdict + hard prefix check.
 *
 * Mocked tests — does NOT hit DB or LLM. Validates the consistency_verdict
 * decision tree: consistent / ambiguous / contradicts / not_applicable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Candidate } from '../../src/inference/retrieval/retrieve.js';

const retrieveMock = vi.fn();
vi.mock('../../src/inference/retrieval/retrieve.js', () => ({
  retrieveCandidates: (...args: unknown[]) => retrieveMock(...args),
}));

const llmClassifyMock = vi.fn();
vi.mock('../../src/modules/pipeline/track-a-description/picker/llm-pick.js', () => ({
  llmClassify: (...args: unknown[]) => llmClassifyMock(...args),
}));

const lookupOverrideMock = vi.fn();
vi.mock('../../src/modules/pipeline/track-b-code/codebook-override.js', () => ({
  lookupTenantOverride: (...args: unknown[]) => lookupOverrideMock(...args),
}));

// Pool query is exercised by resolveAgainstCodebook. We stub it to return
// a deterministic active 12-digit row for the codebook lookup.
const queryMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
  closeDb: vi.fn(),
}));

import { runCodeResolver } from '../../src/modules/pipeline/classify/code-resolver/code-resolver.js';

function candidate(code: string, rrf = 0.04, en = code): Candidate {
  return {
    code,
    description_en: en,
    description_ar: null,
    parent10: code.slice(0, 10),
    path_en: '',
    path_ar: '',
    path_codes: [],
    vec_rank: 1,
    bm25_rank: 1,
    trgm_rank: 1,
    vec_score: 0.9,
    bm25_score: 0.4,
    trgm_score: 0.3,
    rrf_score: rrf,
  };
}

beforeEach(() => {
  retrieveMock.mockReset();
  llmClassifyMock.mockReset();
  lookupOverrideMock.mockReset().mockResolvedValue(null);
  queryMock.mockReset();
});

describe('runCodeResolver — PR 5 consistency_verdict', () => {
  it('returns not_applicable when merchant code is malformed', async () => {
    const r = await runCodeResolver('123', 'malformed', 'wireless headphones', 'naqel');
    expect(r.consistency_verdict).toBe('not_applicable');
    expect(r.valid_prefix).toBeNull();
    expect(r.subtree_candidates).toEqual([]);
    // Retrieval should not have been called when there's no anchor.
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('returns not_applicable when merchant code is absent', async () => {
    const r = await runCodeResolver(null, 'absent', 'anything', 'naqel');
    expect(r.consistency_verdict).toBe('not_applicable');
    expect(r.valid_prefix).toBeNull();
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('emits consistent when anchored top has fit=fits AND unanchored top is in same heading', async () => {
    // Codebook walk: 851830 is HS6 → expandWithFallback returns one child,
    // resolves to 851830000000 active.
    queryMock.mockResolvedValueOnce({
      rows: [{ code: '851830000000', is_deleted: false, replacement_codes: null, description_en: 'headphones', description_ar: null }],
    });
    // Retrieval is called twice in parallel: anchored, then unanchored.
    retrieveMock
      .mockResolvedValueOnce([candidate('851830000000', 0.05, 'headphones')])  // anchored
      .mockResolvedValueOnce([candidate('851830000000', 0.05, 'headphones')]); // unanchored
    llmClassifyMock.mockResolvedValueOnce({
      llmStatus: 'ok',
      llmModel: 'mock',
      latencyMs: 12,
      parseFailed: false,
      verdicts: [{ code: '851830000000', fit: 'fits', rationale: 'subset' }],
      missingAttributes: [],
      rawText: '{}',
    });

    const r = await runCodeResolver('851830', 'short_prefix', 'wireless headphones', 'naqel');
    expect(r.consistency_verdict).toBe('consistent');
    expect(r.valid_prefix).toBe('851830');
    expect(r.subtree_candidates).toHaveLength(1);
    expect(r.subtree_candidates[0]!.fit).toBe('fits');
  });

  it('emits ambiguous when anchored top has fit=partial', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ code: '610910000000', is_deleted: false, replacement_codes: null, description_en: 't-shirt cotton', description_ar: null }],
    });
    retrieveMock
      .mockResolvedValueOnce([candidate('610910000000', 0.05, 't-shirt cotton')])
      .mockResolvedValueOnce([candidate('610910000000', 0.05, 't-shirt cotton')]);
    llmClassifyMock.mockResolvedValueOnce({
      llmStatus: 'ok',
      llmModel: 'mock',
      latencyMs: 12,
      parseFailed: false,
      verdicts: [{ code: '610910000000', fit: 'partial', rationale: 'silent on material' }],
      missingAttributes: ['material'],
      rawText: '{}',
    });

    const r = await runCodeResolver('610910', 'short_prefix', 'T-shirt', 'naqel');
    expect(r.consistency_verdict).toBe('ambiguous');
    expect(r.valid_prefix).toBe('610910');
    expect(r.subtree_candidates[0]!.fit).toBe('partial');
  });

  it('emits ambiguous when anchored top has fit=does_not_fit (still under prefix, but no positive confirmation)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ code: '630710000000', is_deleted: false, replacement_codes: null, description_en: 'floor cloths', description_ar: null }],
    });
    retrieveMock
      .mockResolvedValueOnce([candidate('630710000000', 0.05)])
      .mockResolvedValueOnce([candidate('630710000000', 0.05)]); // unanchored top in same heading
    llmClassifyMock.mockResolvedValueOnce({
      llmStatus: 'ok',
      llmModel: 'mock',
      latencyMs: 12,
      parseFailed: false,
      verdicts: [{ code: '630710000000', fit: 'does_not_fit', rationale: 'wrong leaf' }],
      missingAttributes: [],
      rawText: '{}',
    });

    const r = await runCodeResolver('630710', 'short_prefix', 'storage basket', 'naqel');
    // Prefix matches (no contradicts), but no positive fit → ambiguous.
    expect(r.consistency_verdict).toBe('ambiguous');
  });

  it('emits contradicts when unanchored top-1 has a different prefix from valid_prefix', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ code: '630791000000', is_deleted: false, replacement_codes: null, description_en: 'other made up textile articles', description_ar: null }],
    });
    retrieveMock
      .mockResolvedValueOnce([candidate('630791000000', 0.05)])  // anchored under 6307
      .mockResolvedValueOnce([candidate('460200000000', 0.08)]); // unanchored points at basketwork (chapter 46)
    // llmClassify should NOT be called when contradicts triggers — but if it does we don't care.
    llmClassifyMock.mockResolvedValueOnce({
      llmStatus: 'ok',
      llmModel: 'mock',
      latencyMs: 12,
      parseFailed: false,
      verdicts: [],
      missingAttributes: [],
      rawText: '{}',
    });

    const r = await runCodeResolver('630791', 'short_prefix', 'storage basket', 'naqel');
    expect(r.consistency_verdict).toBe('contradicts');
    expect(r.valid_prefix).toBe('630791');
    // Forced single entry from the unanchored top-1.
    expect(r.subtree_candidates).toHaveLength(1);
    expect(r.subtree_candidates[0]!.code).toBe('460200000000');
    expect(r.subtree_candidates[0]!.fit).toBe('fits');
    expect(r.subtree_candidates[0]!.rationale).toMatch(/unanchored top-1/);
  });

  it('emits not_applicable when subtree retrieval returns zero candidates (broken seed)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ code: '999999000000', is_deleted: false, replacement_codes: null, description_en: 'synthetic', description_ar: null }],
    });
    retrieveMock
      .mockResolvedValueOnce([])                         // anchored: empty
      .mockResolvedValueOnce([candidate('851830000000')]); // unanchored
    const r = await runCodeResolver('999999', 'short_prefix', 'whatever', 'naqel');
    expect(r.consistency_verdict).toBe('not_applicable');
    expect(r.subtree_candidates).toEqual([]);
  });

  it('preserves existing codebook resolution alongside the consistency verdict', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ code: '851830000000', is_deleted: false, replacement_codes: null, description_en: 'headphones', description_ar: null }],
    });
    retrieveMock
      .mockResolvedValueOnce([candidate('851830000000', 0.05)])
      .mockResolvedValueOnce([candidate('851830000000', 0.05)]);
    llmClassifyMock.mockResolvedValueOnce({
      llmStatus: 'ok',
      llmModel: 'mock',
      latencyMs: 12,
      parseFailed: false,
      verdicts: [{ code: '851830000000', fit: 'fits', rationale: 'fits' }],
      missingAttributes: [],
      rawText: '{}',
    });

    const r = await runCodeResolver('851830000000', 'twelve_digit', 'headphones', 'naqel');
    expect(r.resolved_code).toBe('851830000000');
    expect(r.resolution).toBe('passthrough');
    expect(r.consistency_verdict).toBe('consistent');
  });
});
