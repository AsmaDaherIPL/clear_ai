/**
 * PR 3 — identify_fast tests.
 *
 * Mocks callLlmWithRetry at the module boundary. Asserts against the
 * typed IdentifyResult discriminated union output, the trace sibling
 * (pass='fast', web_search_used=false always), and the LLM call
 * arguments (stage='identify_fast', no tools field, Sonnet model).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock-identify-fast-prompt'),
}));
vi.mock('../../src/config/env.js', () => ({
  env: () => ({
    LLM_MODEL: 'mock-haiku',
    LLM_MODEL_STRONG: 'mock-sonnet',
  }),
}));

import { runIdentifyFast } from '../../src/modules/pipeline/v2/identify/fast.js';
import { callLlmWithRetry } from '../../src/inference/llm/client.js';

const mockedCall = vi.mocked(callLlmWithRetry);

function llmReturns(opts: { text: string; latencyMs?: number; model?: string }) {
  return {
    status: 'ok' as const,
    text: opts.text,
    raw: { content: [{ type: 'text', text: opts.text }] },
    latencyMs: opts.latencyMs ?? 1500,
    model: opts.model ?? 'mock-sonnet',
  };
}

beforeEach(() => {
  mockedCall.mockReset();
});

describe('runIdentifyFast — happy path: clean_product', () => {
  it('parses a typical clean_product output', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'cotton t-shirt, knitted',
          family_chapter: '61',
          identity_tokens: [],
          confidence: 0.95,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentifyFast('Cotton t-shirt');
    expect(r.kind).toBe('clean_product');
    if (r.kind === 'clean_product') {
      expect(r.canonical).toBe('cotton t-shirt, knitted');
      expect(r.family_chapter).toBe('61');
      expect(r.confidence).toBe(0.95);
      expect(r.evidence).toBe('world_knowledge');
      expect(r.trace.pass).toBe('fast');
      expect(r.trace.web_search_used).toBe(false);
      expect(r.trace.evidence_mismatch).toBe(false);
    }
  });

  it('honors identity_tokens and caps at 4 entries', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'disposable taped baby diapers, size 2',
          family_chapter: '96',
          identity_tokens: ['pampers', 'extra1', 'extra2', 'extra3', 'extra4-overflow'],
          confidence: 0.92,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentifyFast('Pampers diapers size 2');
    if (r.kind === 'clean_product') {
      expect(r.identity_tokens).toEqual(['pampers', 'extra1', 'extra2', 'extra3']);
    }
  });

  it('flags evidence_mismatch when LLM self-reports evidence=web (tool unavailable in fast pass)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'product',
          family_chapter: '85',
          confidence: 0.9,
          evidence: 'web', // model lying or confused — fast pass has no tool
        }),
      }),
    );
    const r = await runIdentifyFast('something');
    if (r.kind === 'clean_product') {
      expect(r.evidence).toBe('world_knowledge'); // ground truth, not LLM claim
      expect(r.trace.evidence_mismatch).toBe(true);
    }
  });
});

describe('runIdentifyFast — multi_product', () => {
  it('parses multi_product with >=2 products', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'multi_product',
          products: ['iPhone 15 case', 'screen protector'],
        }),
      }),
    );
    const r = await runIdentifyFast('iPhone 15 case + screen protector');
    expect(r.kind).toBe('multi_product');
    if (r.kind === 'multi_product') {
      expect(r.products).toHaveLength(2);
      expect(r.trace.pass).toBe('fast');
    }
  });

  it('downgrades to uninformative+contract when products has fewer than 2 entries', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({ kind: 'multi_product', products: ['just one'] }),
      }),
    );
    const r = await runIdentifyFast('something');
    expect(r.kind).toBe('uninformative');
    if (r.kind === 'uninformative') expect(r.cause).toBe('contract');
  });
});

describe('runIdentifyFast — uninformative cause discrimination', () => {
  it('genuine cause when model returns uninformative (placeholder, unknown brand)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'uninformative',
          reason: 'unrecognised brand token — web search may resolve',
        }),
      }),
    );
    const r = await runIdentifyFast('maxhub');
    expect(r.kind).toBe('uninformative');
    if (r.kind === 'uninformative') {
      expect(r.cause).toBe('genuine');
      expect(r.reason).toContain('web search may resolve');
    }
  });

  it('parse cause when JSON is unparseable', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({ text: 'not json {{{' }),
    );
    const r = await runIdentifyFast('something');
    expect(r.kind).toBe('uninformative');
    if (r.kind === 'uninformative') expect(r.cause).toBe('parse');
  });

  it('transport cause when LLM call returns error status', async () => {
    mockedCall.mockResolvedValueOnce({
      status: 'error',
      text: null,
      raw: null,
      error: 'HTTP 429: rate limited',
      latencyMs: 50,
      model: 'mock-sonnet',
    });
    const r = await runIdentifyFast('something');
    expect(r.kind).toBe('uninformative');
    if (r.kind === 'uninformative') {
      expect(r.cause).toBe('transport');
      expect(r.trace.status).toBe('error');
    }
  });

  it('short_circuit cause when input is empty', async () => {
    const r = await runIdentifyFast('  ');
    expect(r.kind).toBe('uninformative');
    if (r.kind === 'uninformative') {
      expect(r.cause).toBe('short_circuit');
      expect(r.trace.llm_called).toBe(false);
    }
  });

  it('contract cause when clean_product has empty canonical', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: '',
          family_chapter: '85',
          confidence: 0.5,
        }),
      }),
    );
    const r = await runIdentifyFast('weird');
    expect(r.kind).toBe('uninformative');
    if (r.kind === 'uninformative') expect(r.cause).toBe('contract');
  });
});

describe('runIdentifyFast — LLM call shape', () => {
  it('calls Sonnet WITHOUT tools field (no web_search)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'x',
          family_chapter: '01',
          confidence: 0.9,
        }),
      }),
    );
    await runIdentifyFast('thing');
    expect(mockedCall).toHaveBeenCalledTimes(1);
    const callArgs = mockedCall.mock.calls[0]![0];
    expect(callArgs.stage).toBe('identify_fast');
    expect(callArgs.model).toBe('mock-sonnet');
    expect(callArgs.temperature).toBe(0);
    expect(callArgs.maxTokens).toBe(1500);
    // CRITICAL: no tools array on the request
    expect(callArgs.tools).toBeUndefined();
  });

  it('passes retries=0 to callLlmWithRetry (inner 429 retry handles rate limits)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({ kind: 'uninformative', reason: 'test' }),
      }),
    );
    await runIdentifyFast('thing');
    const retriesArg = mockedCall.mock.calls[0]![1];
    expect(retriesArg).toBe(0);
  });
});
