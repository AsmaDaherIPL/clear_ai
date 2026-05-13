/**
 * Verifies llmClassify behavior under operational LLM failures.
 *
 * Parse-class retries are governed by getLlmStagePolicy('picker'): up to 3
 * attempts on empty_text / parse_failed / empty_verdicts, same prompt each
 * time, bounded by totalBudgetMs. Hard llm_failed (HTTP 4xx/5xx that
 * callLlmWithRetry already escalated) is NOT retried here — the circuit
 * breaker handles those at dispatch entry.
 *
 * We don't test against real Foundry — we mock the LLM client.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the LLM client BEFORE importing llmClassify (which captures it at module load).
vi.mock('../../src/inference/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));

// Mock the prompt readers so we don't touch the filesystem.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock-prompt'),
}));

import { llmClassify } from '../../src/modules/pipeline/classify/description-classifier/picker/llm-pick.js';
import { callLlmWithRetry } from '../../src/inference/llm/client.js';
import type { Candidate } from '../../src/inference/retrieval/retrieve.js';

const candidates = [
  { code: '010121100000', description_en: 'horse', description_ar: null, rrf_score: 0.95 },
  { code: '010121100001', description_en: 'mare', description_ar: null, rrf_score: 0.90 },
] as unknown as Candidate[];

const validJson =
  '```json\n{"verdicts":[{"code":"010121100000","fit":"fits","rationale":"matches"},{"code":"010121100001","fit":"does_not_fit","rationale":"different"}],"missing_attributes":[]}\n```';

beforeEach(() => {
  vi.mocked(callLlmWithRetry).mockReset();
});

describe('llmClassify — happy path', () => {
  it('preserves the existing happy path: ok+text+valid_json → verdicts accepted (no retry needed)', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: validJson,
      raw: {},
      latencyMs: 200,
      model: 'mock-sonnet',
    });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('ok');
    expect(r.parseFailed).toBe(false);
    expect(r.verdicts).toHaveLength(2);
    const fits = r.verdicts.find((v) => v.fit === 'fits');
    expect(fits?.code).toBe('010121100000');
    // Happy path doesn't retry.
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(1);
  });
});

describe('llmClassify — retry recovery', () => {
  it('retries on empty_text and accepts the retry result when it succeeds', async () => {
    // First call: status=ok, text=null (empty_text)
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce({
        status: 'ok',
        text: null,
        raw: { content: [] },
        latencyMs: 12,
        model: 'mock-haiku',
      })
      // Second call: real verdicts
      .mockResolvedValueOnce({
        status: 'ok',
        text: validJson,
        raw: {},
        latencyMs: 200,
        model: 'mock-sonnet',
      });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('ok');
    expect(r.verdicts).toHaveLength(2);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(2);
  });

  it('retries on parse_failed and accepts the retry result when it succeeds', async () => {
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce({
        status: 'ok',
        text: 'this is not json at all',
        raw: {},
        latencyMs: 12,
        model: 'mock-haiku',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        text: validJson,
        raw: {},
        latencyMs: 200,
        model: 'mock-sonnet',
      });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('ok');
    expect(r.parseFailed).toBe(false);
    expect(r.verdicts).toHaveLength(2);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(2);
  });

  it('retries on empty_verdicts (valid JSON but no verdicts) — the 2026-05-10 reproducibility variance case', async () => {
    // First call: parses fine but verdicts array is empty (the actual variance
    // pattern observed in production: same input, sometimes returns full
    // verdicts, sometimes returns []).
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce({
        status: 'ok',
        text: '```json\n{"verdicts":[],"missing_attributes":[]}\n```',
        raw: {},
        latencyMs: 12,
        model: 'mock-haiku',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        text: validJson,
        raw: {},
        latencyMs: 200,
        model: 'mock-sonnet',
      });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('ok');
    expect(r.verdicts).toHaveLength(2);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(2);
  });
});

describe('llmClassify — when all attempts fail', () => {
  it('escalates status=ok with text=null to llmStatus=error after all attempts return empty', async () => {
    const emptyTextResult = {
      status: 'ok' as const,
      text: null,
      raw: { content: [] },
      latencyMs: 12,
      model: 'mock-haiku',
    };
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce(emptyTextResult)
      .mockResolvedValueOnce(emptyTextResult)
      .mockResolvedValueOnce(emptyTextResult);
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('error');
    expect(r.verdicts).toEqual([]);
    expect(r.rawError).toMatch(/no text block/i);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(3);
    expect(r.attempts).toBe(3);
  });

  it('escalates status=ok with text="" to llmStatus=error after all attempts return empty', async () => {
    const emptyStringResult = {
      status: 'ok' as const,
      text: '',
      raw: { content: [{ type: 'text', text: '' }] },
      latencyMs: 8,
      model: 'mock-haiku',
    };
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce(emptyStringResult)
      .mockResolvedValueOnce(emptyStringResult)
      .mockResolvedValueOnce(emptyStringResult);
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('error');
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(3);
    expect(r.attempts).toBe(3);
  });

  it('returns parse_failed when all attempts fail to produce valid JSON', async () => {
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce({
        status: 'ok',
        text: 'garbage',
        raw: {},
        latencyMs: 12,
        model: 'mock-haiku',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        text: 'still garbage',
        raw: {},
        latencyMs: 14,
        model: 'mock-haiku',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        text: 'still garbage v3',
        raw: {},
        latencyMs: 14,
        model: 'mock-haiku',
      });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('ok');
    expect(r.parseFailed).toBe(true);
    expect(r.verdicts).toEqual([]);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(3);
    expect(r.attempts).toBe(3);
  });

  it('returns empty verdicts when all attempts produce empty verdicts arrays', async () => {
    const emptyVerdictsResult = {
      status: 'ok' as const,
      text: '```json\n{"verdicts":[],"missing_attributes":[]}\n```',
      raw: {},
      latencyMs: 12,
      model: 'mock-haiku',
    };
    vi.mocked(callLlmWithRetry)
      .mockResolvedValueOnce(emptyVerdictsResult)
      .mockResolvedValueOnce(emptyVerdictsResult)
      .mockResolvedValueOnce(emptyVerdictsResult);
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('ok');
    expect(r.parseFailed).toBe(false);
    expect(r.verdicts).toEqual([]);
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(3);
    expect(r.attempts).toBe(3);
  });
});

describe('llmClassify — hard LLM failures are NOT retried at this layer', () => {
  it('returns immediately on llm_failed (HTTP 4xx/5xx — circuit breaker territory)', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'error',
      text: null,
      raw: null,
      error: 'HTTP 503: bad gateway',
      latencyMs: 12,
      model: 'mock-haiku',
    });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('error');
    expect(r.rawError).toMatch(/HTTP 503/);
    // Hard failures aren't retried at this layer — callLlmWithRetry already
    // retried at the network level, and the circuit breaker handles auth errors.
    expect(vi.mocked(callLlmWithRetry)).toHaveBeenCalledTimes(1);
  });
});
