/**
 * PR-A-2 — Identify stage.
 *
 * Tests runIdentify against mocked Foundry LLM calls. The contract is:
 *
 *   input:  raw_description (blinded to merchant code)
 *   output: IdentifyResult discriminated union with trace sibling
 *   engine: one Sonnet call with web tool, JSON output via extractJson
 *
 * No real LLM contact. callLlmWithRetry is mocked at the module
 * boundary and tests assert against:
 *  - runIdentify's typed output (kind, fields, cause discriminator)
 *  - the LLM call's arguments (stage, model, tools, system prompt)
 *  - the trace sibling (web_search_used, evidence_mismatch, status)
 *
 * Tests cover Master Table 1 cases 1, 2, 5, 7, 8, 10, 11, 14, 15 +
 * defensive paths for malformed LLM output + the post-review additions
 * for trace data, transport-evidence cross-check, and cause
 * discrimination across the five degradation paths.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock-identify-prompt'),
}));

vi.mock('../../src/config/env.js', () => ({
  env: () => ({
    PIPELINE_ARCHITECTURE: 'legacy' as const,
    LLM_MODEL: 'mock-haiku',
    LLM_MODEL_STRONG: 'mock-sonnet',
  }),
}));

import { runIdentify } from '../../src/modules/pipeline/identify/identify.js';
import { callLlmWithRetry } from '../../src/inference/llm/client.js';

const mockedCall = vi.mocked(callLlmWithRetry);

/**
 * Build a stub LLM response. `toolUseBlocks` controls the simulated
 * web_search firing count (counted from `raw.content[]` filtered to
 * `type === 'tool_use'`).
 */
function llmReturns(opts: {
  text: string;
  toolUseBlocks?: number;
  latencyMs?: number;
  model?: string;
}) {
  const tools = Array.from({ length: opts.toolUseBlocks ?? 0 }, () => ({ type: 'tool_use', name: 'web_search' }));
  return {
    status: 'ok' as const,
    text: opts.text,
    raw: {
      content: [...tools, { type: 'text', text: opts.text }],
    },
    latencyMs: opts.latencyMs ?? 100,
    model: opts.model ?? 'mock-sonnet',
  };
}

beforeEach(() => {
  mockedCall.mockReset();
});

// ───────────────────────────────────────────────────────────────────────
// LLM call wiring
// ───────────────────────────────────────────────────────────────────────

describe('runIdentify — LLM call wiring', () => {
  it('passes stage=identify, model=LLM_MODEL_STRONG, web_search tool, and identify.md prompt', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'wireless headphones',
          family_chapter: '85',
          identity_tokens: [],
          confidence: 0.9,
          evidence: 'world_knowledge',
        }),
        toolUseBlocks: 0,
      }),
    );
    await runIdentify('wireless headphones');
    expect(mockedCall).toHaveBeenCalledTimes(1);
    const callArgs = mockedCall.mock.calls[0]![0];
    expect(callArgs.stage).toBe('identify');
    expect(callArgs.model).toBe('mock-sonnet');
    expect(callArgs.tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
    ]);
    expect(callArgs.system).toBe('mock-identify-prompt');
    expect(callArgs.user).toBe('wireless headphones');
    // Second arg is retries; 0 per policy.
    expect(mockedCall.mock.calls[0]![1]).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Happy-path shapes
// ───────────────────────────────────────────────────────────────────────

describe('runIdentify — clean_product', () => {
  it('returns clean_product on a clean tariff noun (training-memory path)', async () => {
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
        toolUseBlocks: 0,
      }),
    );
    const r = await runIdentify('Cotton t-shirt');
    expect(r.kind).toBe('clean_product');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.canonical).toBe('cotton t-shirt, knitted');
    expect(r.family_chapter).toBe('61');
    expect(r.identity_tokens).toEqual([]);
    expect(r.confidence).toBe(0.95);
    expect(r.evidence).toBe('world_knowledge');
    // Trace: LLM called, no web search, no mismatch.
    expect(r.trace.llm_called).toBe(true);
    expect(r.trace.web_search_used).toBe(false);
    expect(r.trace.evidence_mismatch).toBe(false);
    expect(r.trace.status).toBe('ok');
    expect(r.trace.model).toBe('mock-sonnet');
  });

  it('returns clean_product on a recognised brand (web evidence, tool fired)', async () => {
    // Web tool fired (toolUseBlocks=1) AND LLM self-reported evidence='web'.
    // No mismatch.
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'interactive flat-panel display for conference rooms',
          family_chapter: '85',
          identity_tokens: ['maxhub'],
          confidence: 0.82,
          evidence: 'web',
        }),
        toolUseBlocks: 1,
      }),
    );
    const r = await runIdentify('maxhub');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.family_chapter).toBe('85');
    expect(r.identity_tokens).toContain('maxhub');
    expect(r.evidence).toBe('web');
    expect(r.trace.web_search_used).toBe(true);
    expect(r.trace.evidence_mismatch).toBe(false);
  });

  it('cross-checks evidence: LLM says web but tool did not fire → mismatch, transport wins (world_knowledge)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'cotton t-shirt',
          family_chapter: '61',
          identity_tokens: [],
          confidence: 0.95,
          evidence: 'web',
        }),
        toolUseBlocks: 0,
      }),
    );
    const r = await runIdentify('cotton t-shirt');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    // Transport says no tool ran → authoritative evidence is world_knowledge.
    expect(r.evidence).toBe('world_knowledge');
    expect(r.trace.web_search_used).toBe(false);
    expect(r.trace.evidence_mismatch).toBe(true);
  });

  it('cross-checks evidence: LLM says world_knowledge but tool fired → mismatch, transport wins (web)', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'interactive display',
          family_chapter: '85',
          identity_tokens: ['maxhub'],
          confidence: 0.7,
          evidence: 'world_knowledge',
        }),
        toolUseBlocks: 1,
      }),
    );
    const r = await runIdentify('maxhub');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.evidence).toBe('web');
    expect(r.trace.web_search_used).toBe(true);
    expect(r.trace.evidence_mismatch).toBe(true);
  });

  it('preserves foreign-language identity tokens', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'methyldopa antihypertensive tablet',
          family_chapter: '30',
          identity_tokens: ['كولميديتين', 'Colimeditine'],
          confidence: 0.78,
          evidence: 'web',
        }),
        toolUseBlocks: 1,
      }),
    );
    const r = await runIdentify('كولميديتين قرص');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.identity_tokens).toContain('كولميديتين');
  });

  it('coerces invalid family_chapter ("850", 3 digits) to null', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'plastic bag',
          family_chapter: '850',
          identity_tokens: [],
          confidence: 0.7,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentify('plastic bag');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.family_chapter).toBeNull();
  });

  it('coerces out-of-range family_chapter ("00") to null', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'plastic bag',
          family_chapter: '00',
          identity_tokens: [],
          confidence: 0.7,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentify('plastic bag');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.family_chapter).toBeNull();
  });

  it('clamps confidence > 1.0 to 1.0', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'plastic bag',
          family_chapter: '39',
          identity_tokens: [],
          confidence: 1.5,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentify('plastic bag');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.confidence).toBe(1.0);
  });

  it('clamps negative confidence to 0', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'plastic bag',
          family_chapter: '39',
          identity_tokens: [],
          confidence: -0.3,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentify('plastic bag');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.confidence).toBe(0);
  });

  it('truncates identity_tokens beyond 4 entries', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: 'thing',
          family_chapter: '39',
          identity_tokens: ['a', 'b', 'c', 'd', 'e', 'f'],
          confidence: 0.5,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentify('thing');
    if (r.kind !== 'clean_product') throw new Error('expected clean_product');
    expect(r.identity_tokens.length).toBeLessThanOrEqual(4);
  });
});

describe('runIdentify — multi_product', () => {
  it('returns multi_product when input mentions two distinct items', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'multi_product',
          products: ['iPhone 15 case', 'screen protector'],
        }),
      }),
    );
    const r = await runIdentify('iPhone case + screen protector');
    expect(r.kind).toBe('multi_product');
    if (r.kind !== 'multi_product') throw new Error('expected multi_product');
    expect(r.products).toHaveLength(2);
    expect(r.products).toContain('iPhone 15 case');
    expect(r.trace.llm_called).toBe(true);
  });

  it('rejects multi_product with fewer than 2 products as contract violation', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'multi_product',
          products: ['just one thing'],
        }),
      }),
    );
    const r = await runIdentify('something');
    expect(r.kind).toBe('uninformative');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('contract');
    expect(r.reason).toMatch(/fewer than 2 products/i);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Cause discrimination — every degradation path produces a distinct cause
// ───────────────────────────────────────────────────────────────────────

describe('runIdentify — uninformative cause discrimination', () => {
  it("genuine: LLM ran and returned kind='uninformative'", async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'uninformative',
          reason: 'no recognisable product class in the description',
        }),
      }),
    );
    const r = await runIdentify('kitchienware');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('genuine');
    expect(r.reason).toMatch(/no recognisable/i);
  });

  it('short_circuit: empty input, no LLM call', async () => {
    const r = await runIdentify('');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('short_circuit');
    expect(mockedCall).not.toHaveBeenCalled();
    expect(r.trace.llm_called).toBe(false);
    expect(r.trace.status).toBe('skipped');
  });

  it('short_circuit: whitespace-only input', async () => {
    const r = await runIdentify('   \n   ');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('short_circuit');
    expect(mockedCall).not.toHaveBeenCalled();
  });

  it('transport: LLM returned error status', async () => {
    mockedCall.mockResolvedValueOnce({
      status: 'error' as const,
      text: null,
      raw: {},
      latencyMs: 1000,
      model: 'mock-sonnet',
      error: 'upstream 502',
    });
    const r = await runIdentify('cotton t-shirt');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('transport');
    expect(r.reason).toMatch(/upstream 502|error/i);
    expect(r.trace.status).toBe('error');
  });

  it('transport: LLM returned timeout status', async () => {
    mockedCall.mockResolvedValueOnce({
      status: 'timeout' as const,
      text: null,
      raw: {},
      latencyMs: 30000,
      model: 'mock-sonnet',
      error: 'timeout',
    });
    const r = await runIdentify('cotton t-shirt');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('transport');
    expect(r.trace.status).toBe('timeout');
  });

  it('transport: LLM returned ok status but null text', async () => {
    mockedCall.mockResolvedValueOnce({
      status: 'ok' as const,
      text: null,
      raw: {},
      latencyMs: 100,
      model: 'mock-sonnet',
    });
    const r = await runIdentify('cotton t-shirt');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('transport');
    expect(r.reason).toMatch(/empty text/i);
  });

  it('parse: LLM returned invalid JSON', async () => {
    mockedCall.mockResolvedValueOnce(llmReturns({ text: 'not json {{{' }));
    const r = await runIdentify('some product');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('parse');
    expect(r.reason).toMatch(/unparseable/i);
  });

  it('contract: LLM returned an unknown kind value', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({ text: JSON.stringify({ kind: 'something_else', canonical: 'x' }) }),
    );
    const r = await runIdentify('some product');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('contract');
    expect(r.reason).toMatch(/unknown kind/i);
  });

  it('contract: clean_product with empty canonical', async () => {
    mockedCall.mockResolvedValueOnce(
      llmReturns({
        text: JSON.stringify({
          kind: 'clean_product',
          canonical: '',
          family_chapter: null,
          identity_tokens: [],
          confidence: 0.5,
          evidence: 'world_knowledge',
        }),
      }),
    );
    const r = await runIdentify('some product');
    if (r.kind !== 'uninformative') throw new Error('expected uninformative');
    expect(r.cause).toBe('contract');
    expect(r.reason).toMatch(/empty canonical/i);
  });
});
