/**
 * Verifies the operational-failure escalation in llmPick: the provider
 * returning status='ok' with no text MUST surface as llmStatus='error' so
 * `resolve()` produces decision_status='degraded' / reason='llm_unavailable'
 * rather than the misleading 'ambiguous_top_candidates'.
 *
 * We don't test against real Foundry — we mock the LLM client.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the LLM client BEFORE importing llmPick (which captures it at module load).
vi.mock('../../src/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));

// Mock the prompt readers so we don't touch the filesystem.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock-prompt'),
}));

import { llmPick } from '../../src/classification/llm-pick.js';
import { callLlmWithRetry } from '../../src/llm/client.js';
import { resolve } from '../../src/classification/resolve.js';
import type { Candidate } from '../../src/retrieval/retrieve.js';

// llmPick only reads `code` / `description_en` / `description_ar` from each
// candidate, so we cast a minimal-shape literal rather than fabricating every
// retrieval-internal field.
const candidates = [
  { code: '010121100000', description_en: 'horse', description_ar: null, rrf_score: 0.95 },
  { code: '010121100001', description_en: 'mare', description_ar: null, rrf_score: 0.90 },
] as unknown as Candidate[];

describe('llmPick — empty provider response is operational failure', () => {
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
    const r = await llmPick({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('error');
    expect(r.chosenCode).toBeNull();
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
    const r = await llmPick({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('error');
  });

  it('resolve() maps the escalated empty response to degraded/llm_unavailable (NOT ambiguous_top_candidates)', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: null,
      raw: { content: [] },
      latencyMs: 10,
      model: 'mock-haiku',
    });
    const llm = await llmPick({ kind: 'describe', query: 'horse', candidates });
    const decision = resolve({
      gate: { passed: true, topRetrievalScore: 0.95, top2Gap: 0.05 },
      llm,
    });
    expect(decision.decisionStatus).toBe('degraded');
    expect(decision.decisionReason).toBe('llm_unavailable');
  });

  it('preserves the existing happy path: ok+text+valid_json → accepted', async () => {
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: '```json\n{"chosen_code":"010121100000","rationale":"matches","missing_attributes":[]}\n```',
      raw: {},
      latencyMs: 200,
      model: 'mock-sonnet',
    });
    const r = await llmPick({ kind: 'describe', query: 'horse', candidates });
    expect(r.llmStatus).toBe('ok');
    expect(r.chosenCode).toBe('010121100000');
    expect(r.guardTripped).toBe(false);
  });
});
