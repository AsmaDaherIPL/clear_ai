/**
 * PR-A-3 — runConstrain (integration of resolveMerchantCode + scopeFrom).
 *
 * These tests exercise the composed stage. Lower-level units are
 * tested independently in resolve-merchant.test.ts and scope.test.ts.
 *
 * The composition adds three properties:
 *   - resolution is computed once, reused for scope decision
 *   - both halves run in the same call
 *   - the result shape matches the ConstrainResult contract
 *
 * Mocks: codebook helpers, override lookup, LLM client.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/llm/client.js', () => ({
  callLlmWithRetry: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('mock-prompt'),
}));

vi.mock('../../src/config/env.js', () => ({
  env: () => ({
    PIPELINE_ARCHITECTURE: 'legacy' as const,
    LLM_MODEL: 'mock-haiku',
    LLM_MODEL_STRONG: 'mock-sonnet',
  }),
}));

const lookupCodeMock = vi.fn();
const expandWithFallbackMock = vi.fn();
vi.mock('../../src/modules/pipeline/constrain/codebook.js', () => ({
  lookupCode: (...args: unknown[]) => lookupCodeMock(...args),
  expandWithFallback: (...args: unknown[]) => expandWithFallbackMock(...args),
}));

const lookupOverrideMock = vi.fn();
vi.mock('../../src/modules/pipeline/classify/code-resolver/codebook-override.js', () => ({
  lookupTenantOverride: (...args: unknown[]) => lookupOverrideMock(...args),
}));

import { runConstrain } from '../../src/modules/pipeline/constrain/constrain.js';
import type {
  IdentifyResult,
  IdentifyCallTrace,
} from '../../src/modules/pipeline/identify/identify.types.js';

function trace(): IdentifyCallTrace {
  return {
    llm_called: true,
    latency_ms: 100,
    model: 'mock-sonnet',
    status: 'ok',
    web_search_used: false,
    evidence_mismatch: false,
  };
}

function clean(opts: { family_chapter?: string | null; confidence?: number; canonical?: string } = {}): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical: opts.canonical ?? 'cotton t-shirt',
    family_chapter: opts.family_chapter ?? '61',
    identity_tokens: [],
    confidence: opts.confidence ?? 0.9,
    evidence: 'world_knowledge',
    trace: trace(),
  };
}

beforeEach(() => {
  lookupCodeMock.mockReset();
  expandWithFallbackMock.mockReset();
  lookupOverrideMock.mockReset();
});

describe('runConstrain — end-to-end composition', () => {
  it('active merchant + confident identify → merchant_prefix scope', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610910000000',
      is_deleted: false,
      replacement_codes: null,
      description_en: 't-shirt',
      description_ar: null,
    });
    const r = await runConstrain({
      identify: clean(),
      raw_merchant_code: '610910000000',
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.resolution.state).toBe('active');
    expect(r.scope.kind).toBe('merchant_prefix');
    if (r.scope.kind === 'merchant_prefix') {
      expect(r.scope.prefix).toBe('610910');
      expect(r.scope.source).toBe('merchant_active');
    }
  });

  it('no merchant + confident identify with family_chapter → family_chapter scope', async () => {
    const r = await runConstrain({
      identify: clean({ family_chapter: '85', confidence: 0.85 }),
      raw_merchant_code: null,
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.resolution.state).toBe('absent');
    expect(r.scope.kind).toBe('family_chapter');
    if (r.scope.kind === 'family_chapter') expect(r.scope.chapter).toBe('85');
  });

  it('row-22 RESY pattern: low-confidence identify + active merchant → merchant wins', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '640420000000',
      is_deleted: false,
      replacement_codes: null,
      description_en: 'footwear',
      description_ar: null,
    });
    const r = await runConstrain({
      identify: clean({ family_chapter: '27', confidence: 0.2, canonical: 'something' }),
      raw_merchant_code: '640420000000',
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.scope.kind).toBe('merchant_prefix');
    if (r.scope.kind === 'merchant_prefix') {
      expect(r.scope.prefix).toBe('640420');
    }
  });

  it('vacuum + 87150010 (dirty operator override) pattern: identify wins with audit_flag', async () => {
    // Operator override 87150010 → 871500100000 (baby carriage).
    // identify confidently says vacuum (Ch 85).
    lookupOverrideMock.mockResolvedValueOnce({
      targetCode: '871500100000',
      matchedLength: 8,
      matchedSourceCode: '87150010',
    });
    const r = await runConstrain({
      identify: clean({ family_chapter: '85', confidence: 0.9, canonical: 'vacuum cleaner' }),
      raw_merchant_code: '87150010',
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.resolution.state).toBe('override_applied');
    expect(r.scope.kind).toBe('family_chapter');
    if (r.scope.kind === 'family_chapter') {
      expect(r.scope.chapter).toBe('85');
      expect(r.scope.audit_flag).toBe(true);
    }
  });

  it('identify multi_product → escalate (even when merchant code exists)', async () => {
    // multi_product short-circuits scopeFrom regardless of merchant
    // resolution — but resolveMerchantCode still runs (the typed
    // result carries the resolution for audit). Mock the override
    // and codebook lookups so the walk completes deterministically.
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610910000000',
      is_deleted: false,
      replacement_codes: null,
      description_en: 't-shirt',
      description_ar: null,
    });
    const r = await runConstrain({
      identify: {
        kind: 'multi_product',
        products: ['a', 'b'],
        trace: trace(),
      },
      raw_merchant_code: '610910000000',
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.scope.kind).toBe('escalate');
    if (r.scope.kind === 'escalate') expect(r.scope.reason).toBe('identify_multi_product');
    // Resolution still computed (audit-friendly).
    expect(r.resolution.state).toBe('active');
  });

  it('identify uninformative + no merchant → escalate', async () => {
    const r = await runConstrain({
      identify: {
        kind: 'uninformative',
        reason: 'unknown',
        cause: 'genuine',
        trace: trace(),
      },
      raw_merchant_code: null,
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.scope.kind).toBe('escalate');
    if (r.scope.kind === 'escalate') expect(r.scope.reason).toBe('identify_uninformative_no_merchant');
  });

  it('identify uninformative + active merchant → merchant_prefix wins', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '640420000000',
      is_deleted: false,
      replacement_codes: null,
      description_en: 'footwear',
      description_ar: null,
    });
    const r = await runConstrain({
      identify: {
        kind: 'uninformative',
        reason: 'unknown',
        cause: 'genuine',
        trace: trace(),
      },
      raw_merchant_code: '640420000000',
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.scope.kind).toBe('merchant_prefix');
  });
});

describe('runConstrain — trace shape', () => {
  it('emits trace with llm_called=false, override_attempted=false on absent merchant', async () => {
    const r = await runConstrain({
      identify: clean(),
      raw_merchant_code: null,
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.trace.llm_called).toBe(false);
    expect(r.trace.override_attempted).toBe(false);
    expect(r.trace.override_matched).toBe(false);
    expect(r.trace.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits trace with override_attempted=true + override_matched=true on override hit', async () => {
    lookupOverrideMock.mockResolvedValueOnce({
      targetCode: '871500100000',
      matchedLength: 8,
      matchedSourceCode: '87150010',
    });
    const r = await runConstrain({
      identify: clean(),
      raw_merchant_code: '87150010',
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.trace.override_attempted).toBe(true);
    expect(r.trace.override_matched).toBe(true);
  });

  it('emits trace with override_attempted=false when overrides_enabled=false', async () => {
    lookupCodeMock.mockResolvedValueOnce({
      code: '610910000000',
      is_deleted: false,
      replacement_codes: null,
      description_en: null,
      description_ar: null,
    });
    const r = await runConstrain({
      identify: clean(),
      raw_merchant_code: '610910000000',
      operator_slug: 'naqel',
      overrides_enabled: false,
    });
    expect(r.trace.override_attempted).toBe(false);
    expect(r.trace.override_matched).toBe(false);
  });

  it('emits trace with llm_called=true on multi-replacement LLM pick path', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610999999999',
      is_deleted: true,
      replacement_codes: ['610910000000', '610990000000'],
      description_en: null,
      description_ar: null,
    });
    // Mock the LLM since identify has a canonical (so query is non-empty).
    const { callLlmWithRetry } = await import('../../src/inference/llm/client.js');
    vi.mocked(callLlmWithRetry).mockResolvedValueOnce({
      status: 'ok',
      text: JSON.stringify({
        verdicts: [
          { code: '610910000000', fit: 'fits', rationale: 'matches' },
          { code: '610990000000', fit: 'does_not_fit', rationale: 'no' },
        ],
        missing_attributes: [],
      }),
      raw: {},
      latencyMs: 200,
      model: 'mock-sonnet',
    });
    const r = await runConstrain({
      identify: clean(),
      raw_merchant_code: '610999999999',
      operator_slug: 'naqel',
      overrides_enabled: true,
    });
    expect(r.trace.llm_called).toBe(true);
  });
});
