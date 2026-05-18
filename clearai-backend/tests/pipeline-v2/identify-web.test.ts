/**
 * PR 4 — identify_web fallback tests.
 *
 * Same mocking pattern as identify_fast tests. Asserts:
 *  - tools field IS present (web_search_20250305)
 *  - trace.pass === 'web'
 *  - web_search_used reflects tool_use blocks in response
 *  - evidence resolution: ground truth from transport, mismatch flag
 *  - previous_attempt is serialized into the user payload
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock-identify-web-prompt'),
}));
vi.mock('../../src/config/env.js', () => ({
  env: () => ({
    LLM_MODEL: 'mock-haiku',
    LLM_MODEL_STRONG: 'mock-sonnet',
  }),
}));

import { runIdentifyWeb } from '../../src/modules/pipeline/v2/identify/web.js';
import { callLlmWithRetry } from '../../src/inference/llm/client.js';
import type { IdentifyResult } from '../../src/modules/pipeline/v2/types.js';

const mockedCall = vi.mocked(callLlmWithRetry);

function llmReturns(opts: { text: string; toolUseBlocks?: number; latencyMs?: number; model?: string }) {
  const tools = Array.from({ length: opts.toolUseBlocks ?? 0 }, () => ({
    type: 'server_tool_use',
    name: 'web_search',
  }));
  return {
    status: 'ok' as const,
    text: opts.text,
    raw: { content: [...tools, { type: 'text', text: opts.text }] },
    latencyMs: opts.latencyMs ?? 9000,
    model: opts.model ?? 'mock-sonnet',
  };
}

function previousUninformative(reason: string = 'unrecognised brand'): IdentifyResult {
  return {
    kind: 'uninformative',
    cause: 'genuine',
    reason,
    trace: {
      pass: 'fast',
      llm_called: true,
      latency_ms: 2500,
      model: 'mock-sonnet',
      status: 'ok',
      web_search_used: false,
      evidence_mismatch: false,
    },
  };
}

beforeEach(() => mockedCall.mockReset());

describe('runIdentifyWeb — happy path with web search', () => {
  it('parses clean_product with evidence=web when search ran', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        toolUseBlocks: 1,
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'interactive flat-panel display for conference rooms',
          family_chapter: '85',
          identity_tokens: ['maxhub'],
          confidence: 0.82,
          evidence: 'web',
        }),
      }),
    );
    const r = await runIdentifyWeb('maxhub', previousUninformative());
    expect(r.kind).toBe('clean_product');
    if (r.kind === 'clean_product') {
      expect(r.family_chapter).toBe('85');
      expect(r.evidence).toBe('web');
      expect(r.trace.pass).toBe('web');
      expect(r.trace.web_search_used).toBe(true);
      expect(r.trace.evidence_mismatch).toBe(false);
    }
  });

  it('honors world_knowledge evidence when no tool_use block (model skipped search)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        toolUseBlocks: 0,
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'product',
          family_chapter: '85',
          confidence: 0.9,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentifyWeb('something', previousUninformative());
    if (r.kind === 'clean_product') {
      expect(r.evidence).toBe('world_knowledge');
      expect(r.trace.web_search_used).toBe(false);
    }
  });

  it('flags evidence_mismatch when LLM claims web but transport says no tool use', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        toolUseBlocks: 0,
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'product',
          family_chapter: '85',
          confidence: 0.9,
          evidence: 'web', // lie — no tool was called
        }),
      }),
    );
    const r = await runIdentifyWeb('something', previousUninformative());
    if (r.kind === 'clean_product') {
      expect(r.evidence).toBe('world_knowledge'); // ground truth
      expect(r.trace.evidence_mismatch).toBe(true);
    }
  });
});

describe('runIdentifyWeb — refusal paths', () => {
  it('returns uninformative+genuine when web confirms no useful match', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        toolUseBlocks: 1,
        text: JSON.stringify({
          kind: 'uninformative',
          reason: 'web returned no useful matches for short brand-or-model token',
        }),
      }),
    );
    const r = await runIdentifyWeb('TORY 45', previousUninformative());
    expect(r.kind).toBe('uninformative');
    if (r.kind === 'uninformative') {
      expect(r.cause).toBe('genuine');
      expect(r.trace.web_search_used).toBe(true);
    }
  });

  it('uninformative+transport when LLM call errors', async () => {
    mockedCall.mockResolvedValueOnce({
      status: 'timeout',
      text: null,
      raw: null,
      error: 'aborted',
      latencyMs: 30000,
      model: 'mock-sonnet',
    });
    const r = await runIdentifyWeb('thing', previousUninformative());
    expect(r.kind).toBe('uninformative');
    if (r.kind === 'uninformative') {
      expect(r.cause).toBe('transport');
      expect(r.trace.pass).toBe('web');
    }
  });

  it('uninformative+parse when JSON unparseable', async () => {
    mockedCall.mockResolvedValueOnce(llmReturns({ text: 'not json [[' }));
    const r = await runIdentifyWeb('thing', previousUninformative());
    if (r.kind === 'uninformative') expect(r.cause).toBe('parse');
  });

  it('short_circuit on empty input (defensive)', async () => {
    const r = await runIdentifyWeb('   ', previousUninformative());
    if (r.kind === 'uninformative') {
      expect(r.cause).toBe('short_circuit');
      expect(r.trace.llm_called).toBe(false);
    }
  });
});

describe('runIdentifyWeb — brand-only rescue (value-hint-driven flagship pick)', () => {
  it('parses brand_alternatives + low confidence on brand-only inputs', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        toolUseBlocks: 1,
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'maxhub interactive flat-panel display for conference rooms',
          family_chapter: '85',
          identity_tokens: ['maxhub'],
          confidence: 0.5,
          evidence: 'web',
          brand_alternatives: [
            'video conferencing camera',
            'LED signage wall',
            'UC conferencing software',
          ],
        }),
      }),
    );
    const r = await runIdentifyWeb('maxhub', previousUninformative());
    expect(r.kind).toBe('clean_product');
    if (r.kind === 'clean_product') {
      expect(r.confidence).toBe(0.5);
      expect(r.brand_alternatives).toEqual([
        'video conferencing camera',
        'LED signage wall',
        'UC conferencing software',
      ]);
    }
  });

  it('omits brand_alternatives field when the model did not return any', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        toolUseBlocks: 1,
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'product',
          family_chapter: '85',
          confidence: 0.9,
          evidence: 'web',
        }),
      }),
    );
    const r = await runIdentifyWeb('product', previousUninformative());
    if (r.kind === 'clean_product') {
      expect(r.brand_alternatives).toBeUndefined();
    }
  });

  // 2026-05-18: value_hint was REMOVED from the identify_web payload after
  // the "iphone 17 at 222 SAR → accessory" miscall. Brand-only inputs now
  // commit to the flagship product line regardless of price; sanity stage
  // catches suspicious prices downstream. Test pins the new contract.
  it('does not forward any value/price hint into the user payload', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({ kind: 'uninformative', reason: 't' }),
      }),
    );
    await runIdentifyWeb('maxhub', previousUninformative());
    const args = mockedCall.mock.calls[0]![0];
    expect(args.user).not.toContain('value_hint');
    expect(args.user).not.toContain('amount');
    expect(args.user).not.toContain('currency');
  });
});

describe('runIdentifyWeb — LLM call shape', () => {
  it('passes the web_search tool to callLlmWithRetry', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({ text: JSON.stringify({ kind: 'uninformative', reason: 't' }) }),
    );
    await runIdentifyWeb('x', previousUninformative());
    const args = mockedCall.mock.calls[0]![0];
    expect(args.stage).toBe('identify_web_fallback');
    expect(args.tools).toBeDefined();
    expect(args.tools![0]).toMatchObject({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 1,
    });
  });

  it('serialises previous_attempt into user payload as JSON', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({ text: JSON.stringify({ kind: 'uninformative', reason: 't' }) }),
    );
    await runIdentifyWeb('maxhub', previousUninformative('unrecognised brand'));
    const userPayload = mockedCall.mock.calls[0]![0].user;
    const parsed = JSON.parse(userPayload);
    expect(parsed.description).toBe('maxhub');
    expect(parsed.previous_attempt.kind).toBe('uninformative');
    expect(parsed.previous_attempt.reason).toBe('unrecognised brand');
  });

  it('summarises clean_product previous attempts compactly (no trace bloat)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({ text: JSON.stringify({ kind: 'uninformative', reason: 't' }) }),
    );
    const previousClean: IdentifyResult = {
      kind: 'clean_product',
      canonical: 'previous canonical',
      family_chapter: '85',
      identity_tokens: ['x'],
      confidence: 0.7,
      evidence: 'world_knowledge',
      trace: {
        pass: 'fast',
        llm_called: true,
        latency_ms: 1000,
        model: 'mock-sonnet',
        status: 'ok',
        web_search_used: false,
        evidence_mismatch: false,
      },
    };
    await runIdentifyWeb('x', previousClean);
    const userPayload = mockedCall.mock.calls[0]![0].user;
    const parsed = JSON.parse(userPayload);
    expect(parsed.previous_attempt.kind).toBe('clean_product');
    expect(parsed.previous_attempt.canonical).toBe('previous canonical');
    // No trace field in the summary — keeps the prompt small
    expect(parsed.previous_attempt.trace).toBeUndefined();
  });

  it('outer retries=0 (inner 429 retry handles rate limits)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({ text: JSON.stringify({ kind: 'uninformative', reason: 't' }) }),
    );
    await runIdentifyWeb('x', previousUninformative());
    expect(mockedCall.mock.calls[0]![1]).toBe(0);
  });
});
