/**
 * PR-A-3 — resolveMerchantCode.
 *
 * Deterministic codebook walk + override lookup + (small) LLM pick
 * for multi-replacement disambiguation. Mocks the DB pool and the
 * override lookup; mocks the LLM client.
 *
 * Tests cover every terminal state of the MerchantResolution union:
 *   - absent
 *   - malformed
 *   - active
 *   - replaced_single
 *   - override_applied
 *   - llm_picked_replacement
 *   - expanded_prefix
 *   - unknown
 *
 * Plus the `overrides_enabled` flag interaction (when false, override
 * lookup is skipped).
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

// Mock the codebook db helpers + override lookup.
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

import { resolveMerchantCode } from '../../src/modules/pipeline/constrain/resolve-merchant.js';
import { callLlmWithRetry } from '../../src/inference/llm/client.js';
import type { IdentifyResult, IdentifyCallTrace } from '../../src/modules/pipeline/identify/identify.types.js';

const mockedLlm = vi.mocked(callLlmWithRetry);

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

function clean(canonical = 'cotton t-shirt'): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical,
    family_chapter: '61',
    identity_tokens: [],
    confidence: 0.9,
    evidence: 'world_knowledge',
    trace: trace(),
  };
}

beforeEach(() => {
  lookupCodeMock.mockReset();
  expandWithFallbackMock.mockReset();
  lookupOverrideMock.mockReset();
  mockedLlm.mockReset();
});

// ───────────────────────────────────────────────────────────────────────
// absent / malformed
// ───────────────────────────────────────────────────────────────────────

describe('resolveMerchantCode — absent / malformed', () => {
  it('returns absent when raw_merchant_code is null', async () => {
    const r = await resolveMerchantCode(null, clean(), 'naqel', true);
    expect(r.state).toBe('absent');
    expect(lookupOverrideMock).not.toHaveBeenCalled();
    expect(lookupCodeMock).not.toHaveBeenCalled();
  });

  it('returns absent when raw_merchant_code is empty string', async () => {
    const r = await resolveMerchantCode('', clean(), 'naqel', true);
    expect(r.state).toBe('absent');
  });

  it('returns malformed when code has < 6 digits', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    const r = await resolveMerchantCode('123', clean(), 'naqel', true);
    expect(r.state).toBe('malformed');
    if (r.state === 'malformed') expect(r.source_code).toBe('123');
  });

  it('returns malformed when code has > 12 digits', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    const r = await resolveMerchantCode('1234567890123', clean(), 'naqel', true);
    expect(r.state).toBe('malformed');
  });
});

// ───────────────────────────────────────────────────────────────────────
// active code passthrough
// ───────────────────────────────────────────────────────────────────────

describe('resolveMerchantCode — active', () => {
  it('returns active for a 12-digit code present in codebook and not deleted', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610910000000',
      is_deleted: false,
      replacement_codes: null,
      description_en: 't-shirt',
      description_ar: null,
    });
    const r = await resolveMerchantCode('610910000000', clean(), 'naqel', true);
    expect(r.state).toBe('active');
    if (r.state === 'active') expect(r.resolved_code).toBe('610910000000');
  });
});

// ───────────────────────────────────────────────────────────────────────
// deprecated single replacement
// ───────────────────────────────────────────────────────────────────────

describe('resolveMerchantCode — replaced_single', () => {
  it('returns replaced_single when deleted code has exactly one replacement', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610999999999',
      is_deleted: true,
      replacement_codes: ['610910000000'],
      description_en: null,
      description_ar: null,
    });
    const r = await resolveMerchantCode('610999999999', clean(), 'naqel', true);
    expect(r.state).toBe('replaced_single');
    if (r.state === 'replaced_single') {
      expect(r.resolved_code).toBe('610910000000');
      expect(r.source_code).toBe('610999999999');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// override applied
// ───────────────────────────────────────────────────────────────────────

describe('resolveMerchantCode — override_applied', () => {
  it('returns override_applied when override matches', async () => {
    lookupOverrideMock.mockResolvedValueOnce({
      targetCode: '610910000000',
      matchedLength: 8,
      matchedSourceCode: '61099999',
    });
    const r = await resolveMerchantCode('610999999999', clean(), 'naqel', true);
    expect(r.state).toBe('override_applied');
    if (r.state === 'override_applied') {
      expect(r.resolved_code).toBe('610910000000');
      expect(r.source_code).toBe('610999999999');
      expect(r.override_matched_length).toBe(8);
    }
    // Override fires BEFORE codebook lookup; lookup may still run if
    // implementation chooses to walk through the codebook for validation,
    // but the typed state is `override_applied`.
  });

  it('skips override lookup entirely when overrides_enabled=false', async () => {
    lookupCodeMock.mockResolvedValueOnce({
      code: '610910000000',
      is_deleted: false,
      replacement_codes: null,
      description_en: null,
      description_ar: null,
    });
    const r = await resolveMerchantCode('610910000000', clean(), 'naqel', false);
    expect(lookupOverrideMock).not.toHaveBeenCalled();
    expect(r.state).toBe('active');
  });
});

// ───────────────────────────────────────────────────────────────────────
// deprecated multiple replacements + LLM pick
// ───────────────────────────────────────────────────────────────────────

describe('resolveMerchantCode — llm_picked_replacement', () => {
  it('LLM picks one when deleted code has multiple replacements and no override matches', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610999999999',
      is_deleted: true,
      replacement_codes: ['610910000000', '610990000000'],
      description_en: null,
      description_ar: null,
    });
    mockedLlm.mockResolvedValueOnce({
      status: 'ok',
      text: JSON.stringify({
        verdicts: [
          { code: '610910000000', fit: 'fits', rationale: 'matches t-shirt' },
          { code: '610990000000', fit: 'does_not_fit', rationale: 'other' },
        ],
        missing_attributes: [],
      }),
      raw: {},
      latencyMs: 200,
      model: 'mock-sonnet',
    });
    const r = await resolveMerchantCode('610999999999', clean(), 'naqel', true);
    expect(r.state).toBe('llm_picked_replacement');
    if (r.state === 'llm_picked_replacement') {
      expect(r.resolved_code).toBe('610910000000');
      expect(r.candidates).toContain('610910000000');
      expect(r.candidates).toContain('610990000000');
    }
  });

  it('returns unknown (cause=llm_pick_failed_replacement, matched_prefix=HS6) when LLM picks no fit', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610999999999',
      is_deleted: true,
      replacement_codes: ['610910000000', '610990000000'],
      description_en: null,
      description_ar: null,
    });
    mockedLlm.mockResolvedValueOnce({
      status: 'ok',
      text: JSON.stringify({
        verdicts: [
          { code: '610910000000', fit: 'does_not_fit', rationale: 'no' },
          { code: '610990000000', fit: 'does_not_fit', rationale: 'no' },
        ],
        missing_attributes: [],
      }),
      raw: {},
      latencyMs: 200,
      model: 'mock-sonnet',
    });
    const r = await resolveMerchantCode('610999999999', clean(), 'naqel', true);
    expect(r.state).toBe('unknown');
    if (r.state === 'unknown') {
      expect(r.cause).toBe('llm_pick_failed_replacement');
      expect(r.matched_prefix).toBe('610999'); // HS6 of source code
    }
  });

  it('returns unknown (cause=llm_pick_failed_replacement) when LLM transport fails on multi-replacement pick', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610999999999',
      is_deleted: true,
      replacement_codes: ['610910000000', '610990000000'],
      description_en: null,
      description_ar: null,
    });
    mockedLlm.mockResolvedValueOnce({
      status: 'error',
      text: null,
      raw: {},
      latencyMs: 1000,
      model: 'mock-sonnet',
      error: '502',
    });
    const r = await resolveMerchantCode('610999999999', clean(), 'naqel', true);
    expect(r.state).toBe('unknown');
    if (r.state === 'unknown') {
      expect(r.cause).toBe('llm_pick_failed_replacement');
      expect(r.matched_prefix).toBe('610999');
    }
  });

  it('multi_product identify SKIPS the LLM call for replacement pick (empty query short-circuit)', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610999999999',
      is_deleted: true,
      replacement_codes: ['610910000000', '610990000000'],
      description_en: null,
      description_ar: null,
    });
    // No mockedLlm.mockResolvedValueOnce — we assert it's never called.
    const multiProductIdentify = {
      kind: 'multi_product' as const,
      products: ['a', 'b'],
      trace: clean().trace,
    };
    const r = await resolveMerchantCode('610999999999', multiProductIdentify, 'naqel', true);
    expect(mockedLlm).not.toHaveBeenCalled();
    expect(r.state).toBe('unknown');
    if (r.state === 'unknown') {
      expect(r.cause).toBe('llm_pick_failed_replacement');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// expanded_prefix (6-11 digit codes)
// ───────────────────────────────────────────────────────────────────────

describe('resolveMerchantCode — expanded_prefix', () => {
  it('walks prefix and picks single child deterministically', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    expandWithFallbackMock.mockResolvedValueOnce({
      children: [
        {
          code: '640420000000',
          is_deleted: false,
          replacement_codes: null,
          description_en: 'footwear',
          description_ar: null,
        },
      ],
      matched_prefix: '640420',
    });
    const r = await resolveMerchantCode('640420', clean(), 'naqel', true);
    expect(r.state).toBe('expanded_prefix');
    if (r.state === 'expanded_prefix') {
      expect(r.resolved_code).toBe('640420000000');
      expect(r.valid_prefix).toBe('640420');
      expect(r.source_code).toBe('640420');
    }
  });

  it('walks prefix and LLM picks among multiple children', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    expandWithFallbackMock.mockResolvedValueOnce({
      children: [
        { code: '640420100000', is_deleted: false, replacement_codes: null, description_en: 'a', description_ar: null },
        { code: '640420200000', is_deleted: false, replacement_codes: null, description_en: 'b', description_ar: null },
      ],
      matched_prefix: '640420',
    });
    mockedLlm.mockResolvedValueOnce({
      status: 'ok',
      text: JSON.stringify({
        verdicts: [
          { code: '640420100000', fit: 'fits', rationale: 'matches' },
          { code: '640420200000', fit: 'does_not_fit', rationale: 'no' },
        ],
        missing_attributes: [],
      }),
      raw: {},
      latencyMs: 200,
      model: 'mock-sonnet',
    });
    const r = await resolveMerchantCode('640420', clean(), 'naqel', true);
    expect(r.state).toBe('expanded_prefix');
    if (r.state === 'expanded_prefix') {
      expect(r.resolved_code).toBe('640420100000');
      expect(r.valid_prefix).toBe('640420');
    }
  });

  it('returns unknown (cause=prefix_empty, matched_prefix=null) when prefix has zero children', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    expandWithFallbackMock.mockResolvedValueOnce({
      children: [],
      matched_prefix: '999999',
    });
    const r = await resolveMerchantCode('999999', clean(), 'naqel', true);
    expect(r.state).toBe('unknown');
    if (r.state === 'unknown') {
      expect(r.cause).toBe('prefix_empty');
      expect(r.matched_prefix).toBeNull();
    }
  });

  it('returns unknown (cause=llm_pick_failed_prefix, matched_prefix preserved) when prefix has multiple children but LLM fails', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    expandWithFallbackMock.mockResolvedValueOnce({
      children: [
        { code: '640420100000', is_deleted: false, replacement_codes: null, description_en: 'a', description_ar: null },
        { code: '640420200000', is_deleted: false, replacement_codes: null, description_en: 'b', description_ar: null },
      ],
      matched_prefix: '640420',
    });
    mockedLlm.mockResolvedValueOnce({
      status: 'error',
      text: null,
      raw: {},
      latencyMs: 1000,
      model: 'mock-sonnet',
      error: '502',
    });
    const r = await resolveMerchantCode('640420', clean(), 'naqel', true);
    expect(r.state).toBe('unknown');
    if (r.state === 'unknown') {
      expect(r.cause).toBe('llm_pick_failed_prefix');
      expect(r.matched_prefix).toBe('640420');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// unknown 12-digit code
// ───────────────────────────────────────────────────────────────────────

describe('resolveMerchantCode — unknown', () => {
  it('returns unknown (cause=not_in_codebook) when 12-digit code does not exist in codebook', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce(null);
    const r = await resolveMerchantCode('999999999999', clean(), 'naqel', true);
    expect(r.state).toBe('unknown');
    if (r.state === 'unknown') {
      expect(r.source_code).toBe('999999999999');
      expect(r.cause).toBe('not_in_codebook');
      expect(r.matched_prefix).toBeNull();
    }
  });

  it('returns unknown (cause=no_replacements) when deleted code has zero replacements', async () => {
    lookupOverrideMock.mockResolvedValueOnce(null);
    lookupCodeMock.mockResolvedValueOnce({
      code: '610999999999',
      is_deleted: true,
      replacement_codes: [],
      description_en: null,
      description_ar: null,
    });
    const r = await resolveMerchantCode('610999999999', clean(), 'naqel', true);
    expect(r.state).toBe('unknown');
    if (r.state === 'unknown') {
      expect(r.cause).toBe('no_replacements');
    }
  });
});
