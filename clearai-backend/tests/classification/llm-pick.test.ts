/**
 * Verifies operational-failure escalation in llmClassify: the provider
 * returning status='ok' with no text MUST surface as llmStatus='error' so
 * the classifier reports an operational failure rather than a misleading
 * empty verdicts list.
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

import { llmClassify } from '../../src/modules/pipeline/track-a-description/picker/llm-pick.js';
import { callLlmWithRetry } from '../../src/inference/llm/client.js';
import type { Candidate } from '../../src/inference/retrieval/retrieve.js';

const candidates = [
  { code: '010121100000', description_en: 'horse', description_ar: null, rrf_score: 0.95 },
  { code: '010121100001', description_en: 'mare', description_ar: null, rrf_score: 0.90 },
] as unknown as Candidate[];

describe('llmClassify — empty provider response is operational failure', () => {
  beforeEach(() => {
    vi.mocked(callLlmWithRetry).mockReset();
  });

  it('escalates status=ok with text=null to llmStatus=error', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: null,
      raw: { content: [] },
      latencyMs: 12,
      model: 'mock-haiku',
    });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('error');
    expect(r.verdicts).toEqual([]);
    expect(r.rawError).toMatch(/no text block/i);
  });

  it('escalates status=ok with text="" to llmStatus=error', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: '',
      raw: { content: [{ type: 'text', text: '' }] },
      latencyMs: 8,
      model: 'mock-haiku',
    });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('error');
  });

  it('preserves the existing happy path: ok+text+valid_json → verdicts accepted', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: '```json\n{"verdicts":[{"code":"010121100000","fit":"fits","rationale":"matches"},{"code":"010121100001","fit":"does_not_fit","rationale":"different"}],"missing_attributes":[]}\n```',
      raw: {},
      latencyMs: 200,
      model: 'mock-sonnet',
    });
    const r = await llmClassify({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('ok');
    expect(r.parseFailed).toBe(false);
    const fits = r.verdicts.find((v) => v.fit === 'fits');
    expect(fits?.code).toBe('010121100000');
  });
});
