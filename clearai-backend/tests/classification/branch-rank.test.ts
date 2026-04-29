/**
 * Tests for branch-rank — the Sonnet rerank step that ranks every leaf
 * under a chosen code's HS-8 branch with per-row reasoning, optionally
 * overriding the picker.
 *
 * The integration path (real Sonnet call) is exercised by the route
 * smoke tests with BRANCH_RANK_ENABLED=1. Here we pin the unit-level
 * behaviours: feature flag, defensive short-circuits, hallucination
 * guard, override mechanics. The LLM client is mocked.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));

import { callLlmWithRetry } from '../../src/llm/client.js';
import { rankBranch } from '../../src/classification/branch-rank.js';
import type { BranchLeaf } from '../../src/classification/branch-enumerate.js';

const baseLeaves: BranchLeaf[] = [
  { code: '851762900009', description_en: 'wireless headphones', description_ar: null, source: 'branch_8' },
  { code: '851762900002', description_en: 'smart watch w/ sim', description_ar: null, source: 'branch_8' },
  { code: '851762900007', description_en: 'GPS vehicle tracker', description_ar: null, source: 'branch_8' },
];

beforeEach(() => {
  vi.mocked(callLlmWithRetry).mockReset();
});

describe('rankBranch — defensive short-circuits', () => {
  it('skips when feature flag disabled', async () => {
    const r = await rankBranch({
      query: 'wireless headphones',
      chosenCode: '851762900009',
      leaves: baseLeaves,
      opts: { enabled: false },
    });
    expect(r.invoked).toBe('disabled');
    expect(r.effectiveCode).toBe('851762900009');
    expect(r.agreesWithPicker).toBe(true);
    expect(callLlmWithRetry).not.toHaveBeenCalled();
  });

  it('skips when fewer leaves than minLeavesForLlm', async () => {
    const r = await rankBranch({
      query: 'foo',
      chosenCode: '851762900009',
      leaves: [baseLeaves[0]!],
      opts: { enabled: true, minLeavesForLlm: 2 },
    });
    expect(r.invoked).toBe('not_enough_leaves');
    expect(callLlmWithRetry).not.toHaveBeenCalled();
  });

  it('bails when chosenCode is not in the leaves list', async () => {
    const r = await rankBranch({
      query: 'foo',
      chosenCode: '999999999999', // not in baseLeaves
      leaves: baseLeaves,
      opts: { enabled: true },
    });
    expect(r.invoked).toBe('not_enough_leaves');
    expect(r.effectiveCode).toBe('999999999999'); // picker's pick stands
    expect(callLlmWithRetry).not.toHaveBeenCalled();
  });
});

describe('rankBranch — LLM path', () => {
  it('parses a valid ranking and reports agreement with picker', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: JSON.stringify({
        ranking: [
          { code: '851762900009', rank: 1, fit: 'fits', reason: 'Wireless audio output, matches user input.' },
          { code: '851762900002', rank: 2, fit: 'excludes', reason: 'Smart watch, not headphones.' },
          { code: '851762900007', rank: 3, fit: 'excludes', reason: 'GPS tracker, requires automotive integration.' },
        ],
        top_pick: '851762900009',
        agrees_with_picker: true,
      }),
      raw: null,
      latencyMs: 1234,
      model: 'claude-sonnet-test',
    });

    const r = await rankBranch({
      query: 'wireless headphones',
      chosenCode: '851762900009',
      leaves: baseLeaves,
      opts: { enabled: true },
    });

    expect(r.invoked).toBe('llm');
    expect(r.ranking).toHaveLength(3);
    expect(r.ranking[0]!.code).toBe('851762900009');
    expect(r.ranking[0]!.fit).toBe('fits');
    expect(r.topPick).toBe('851762900009');
    expect(r.agreesWithPicker).toBe(true);
    expect(r.effectiveCode).toBe('851762900009');
  });

  it('records an override when ranking #1 differs from chosenCode', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: JSON.stringify({
        ranking: [
          { code: '851762900002', rank: 1, fit: 'fits', reason: 'Better match.' },
          { code: '851762900009', rank: 2, fit: 'partial', reason: 'Close but missing X.' },
          { code: '851762900007', rank: 3, fit: 'excludes', reason: 'Different product.' },
        ],
        top_pick: '851762900002',
        agrees_with_picker: false,
      }),
      raw: null,
      latencyMs: 1500,
      model: 'claude-sonnet-test',
    });

    const r = await rankBranch({
      query: 'something',
      chosenCode: '851762900009',
      leaves: baseLeaves,
      opts: { enabled: true },
    });

    expect(r.invoked).toBe('llm');
    expect(r.topPick).toBe('851762900002');
    expect(r.agreesWithPicker).toBe(false);
    expect(r.effectiveCode).toBe('851762900002'); // override applied
  });
});

describe('rankBranch — hallucination guard', () => {
  it('trips the guard when the LLM invents a code', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: JSON.stringify({
        ranking: [
          { code: '851762900009', rank: 1, fit: 'fits', reason: 'ok' },
          { code: '999999999999', rank: 2, fit: 'excludes', reason: 'invented' }, // not in input
          { code: '851762900007', rank: 3, fit: 'excludes', reason: 'ok' },
        ],
        top_pick: '851762900009',
        agrees_with_picker: true,
      }),
      raw: null,
      latencyMs: 1000,
      model: 'claude-sonnet-test',
    });

    const r = await rankBranch({
      query: 'q',
      chosenCode: '851762900009',
      leaves: baseLeaves,
      opts: { enabled: true },
    });

    // Guard trips because the validated set doesn't contain all three input codes
    expect(r.invoked).toBe('guard_tripped');
    expect(r.ranking).toEqual([]);
    expect(r.effectiveCode).toBe('851762900009'); // picker's pick stands
  });

  it('trips the guard when the LLM omits a code', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: JSON.stringify({
        ranking: [
          { code: '851762900009', rank: 1, fit: 'fits', reason: 'ok' },
          { code: '851762900002', rank: 2, fit: 'excludes', reason: 'ok' },
          // 851762900007 missing
        ],
        top_pick: '851762900009',
        agrees_with_picker: true,
      }),
      raw: null,
      latencyMs: 1000,
      model: 'claude-sonnet-test',
    });

    const r = await rankBranch({
      query: 'q',
      chosenCode: '851762900009',
      leaves: baseLeaves,
      opts: { enabled: true },
    });

    expect(r.invoked).toBe('guard_tripped');
    expect(r.effectiveCode).toBe('851762900009');
  });
});

describe('rankBranch — failure modes', () => {
  it('falls back to picker when LLM returns error status', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'error',
      text: null,
      raw: null,
      error: 'HTTP 500',
      latencyMs: 100,
      model: 'claude-sonnet-test',
    });

    const r = await rankBranch({
      query: 'q',
      chosenCode: '851762900009',
      leaves: baseLeaves,
      opts: { enabled: true },
    });

    expect(r.invoked).toBe('llm_failed');
    expect(r.effectiveCode).toBe('851762900009');
  });

  it('falls back to picker when LLM returns unparseable JSON', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: 'this is not JSON at all',
      raw: null,
      latencyMs: 100,
      model: 'claude-sonnet-test',
    });

    const r = await rankBranch({
      query: 'q',
      chosenCode: '851762900009',
      leaves: baseLeaves,
      opts: { enabled: true },
    });

    expect(r.invoked).toBe('llm_failed');
    expect(r.effectiveCode).toBe('851762900009');
  });
});
