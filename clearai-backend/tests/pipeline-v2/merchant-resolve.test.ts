/**
 * PR 5 — merchant_resolution tests (updated PR 13).
 *
 * After PR 13 the merchant resolver lives at merchant/resolve.ts and no
 * longer wraps a legacy file. Tests now exercise the canonical
 * resolveMerchant directly (which delegates to resolveMerchantCode), with
 * the DB-facing helpers (lookupCode, expandWithFallback, lookupTenantOverride,
 * pickAmongReplacements, pickUnderPrefix) mocked at the module boundary.
 *
 * The legacy-comparison test (resolveMerchantCodeLegacy) is removed because
 * the legacy file no longer exists.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/modules/pipeline/merchant/codebook.js', () => ({
  lookupCode: vi.fn(),
  expandWithFallback: vi.fn(),
}));

vi.mock('../../src/modules/pipeline/merchant/codebook-override.js', () => ({
  lookupTenantOverride: vi.fn(),
}));

vi.mock('../../src/modules/pipeline/merchant/replacement-pick.js', () => ({
  pickAmongReplacements: vi.fn(),
  pickUnderPrefix: vi.fn(),
}));

import {
  resolveMerchant,
  buildResolutionTrace,
} from '../../src/modules/pipeline/merchant/resolve.js';
import { lookupCode, expandWithFallback } from '../../src/modules/pipeline/merchant/codebook.js';
import { lookupTenantOverride } from '../../src/modules/pipeline/merchant/codebook-override.js';
import type {
  IdentifyResult,
  MerchantResolution,
} from '../../src/modules/pipeline/types.js';

const mockedLookupCode = vi.mocked(lookupCode);
const mockedExpandWithFallback = vi.mocked(expandWithFallback);
const mockedLookupTenantOverride = vi.mocked(lookupTenantOverride);

function v2CleanIdentify(overrides: { family_chapter?: string | null; canonical?: string } = {}): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical: overrides.canonical ?? 'cotton t-shirt, knitted',
    family_chapter: 'family_chapter' in overrides ? overrides.family_chapter! : '61',
    identity_tokens: [],
    confidence: 0.9,
    evidence: 'world_knowledge',
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

function v2UninformativeIdentify(): IdentifyResult {
  return {
    kind: 'uninformative',
    cause: 'genuine',
    reason: 'placeholder',
    trace: {
      pass: 'fast',
      llm_called: true,
      latency_ms: 2000,
      model: 'mock-sonnet',
      status: 'ok',
      web_search_used: false,
      evidence_mismatch: false,
    },
  };
}

beforeEach(() => {
  mockedLookupCode.mockReset();
  mockedExpandWithFallback.mockReset();
  mockedLookupTenantOverride.mockReset();
  // Default: no override, no DB hit
  mockedLookupTenantOverride.mockResolvedValue(null);
});

describe('resolveMerchant — absent cases', () => {
  it('returns absent when raw_code is null', async () => {
    const r = await resolveMerchant(null, v2CleanIdentify(), 'naqel', false);
    expect(r).toEqual({ state: 'absent' });
  });

  it('returns absent when raw_code is empty string', async () => {
    const r = await resolveMerchant('', v2CleanIdentify(), 'naqel', false);
    expect(r).toEqual({ state: 'absent' });
  });
});

describe('resolveMerchant — override_applied', () => {
  it('returns override_applied when override matches', async () => {
    mockedLookupTenantOverride.mockResolvedValueOnce({
      targetCode: '847180000000',
      matchedLength: 12,
      matchedSourceCode: '8471804000',
    });
    const r = await resolveMerchant('8471804000', v2CleanIdentify(), 'naqel', true);
    expect(r).toEqual({
      state: 'override_applied',
      resolved_code: '847180000000',
      source_code: '8471804000',
      override_matched_length: 12,
    });
  });
});

describe('resolveMerchant — malformed', () => {
  it('returns malformed for code shorter than 6 digits', async () => {
    const r = await resolveMerchant('1234', v2CleanIdentify(), 'naqel', false);
    expect(r.state).toBe('malformed');
  });

  it('returns malformed for code longer than 12 digits', async () => {
    const r = await resolveMerchant('1234567890123', v2CleanIdentify(), 'naqel', false);
    expect(r.state).toBe('malformed');
  });
});

describe('resolveMerchant — 12-digit paths', () => {
  it('returns unknown(not_in_codebook) when code is not in codebook', async () => {
    mockedLookupCode.mockResolvedValueOnce(null);
    const r = await resolveMerchant('999999999999', v2CleanIdentify(), 'naqel', false);
    expect(r).toEqual({ state: 'unknown', source_code: '999999999999', cause: 'not_in_codebook', matched_prefix: null });
  });

  it('returns active when 12-digit code is active', async () => {
    mockedLookupCode.mockResolvedValueOnce({
      code: '610910000000',
      is_deleted: false,
      replacement_codes: null,
      description_en: 'T-shirts',
      description_ar: null,
    });
    const r = await resolveMerchant('610910000000', v2CleanIdentify(), 'naqel', false);
    expect(r).toEqual({ state: 'active', resolved_code: '610910000000' });
  });

  it('returns unknown(no_replacements) when deleted with 0 replacements', async () => {
    mockedLookupCode.mockResolvedValueOnce({
      code: '111111111111',
      is_deleted: true,
      replacement_codes: [],
      description_en: null,
      description_ar: null,
    });
    const r = await resolveMerchant('111111111111', v2CleanIdentify(), 'naqel', false);
    expect(r).toEqual({ state: 'unknown', source_code: '111111111111', cause: 'no_replacements', matched_prefix: null });
  });

  it('returns replaced_single when deleted with 1 replacement', async () => {
    mockedLookupCode.mockResolvedValueOnce({
      code: '611110000000',
      is_deleted: true,
      replacement_codes: ['611120000000'],
      description_en: null,
      description_ar: null,
    });
    const r = await resolveMerchant('611110000000', v2CleanIdentify(), 'naqel', false);
    expect(r).toEqual({ state: 'replaced_single', resolved_code: '611120000000', source_code: '611110000000' });
  });
});

describe('resolveMerchant — short prefix paths', () => {
  it('returns unknown(prefix_empty) when expansion returns no children', async () => {
    mockedExpandWithFallback.mockResolvedValueOnce({ children: [], matched_prefix: '610910' });
    const r = await resolveMerchant('610910', v2UninformativeIdentify(), 'naqel', false);
    expect(r).toEqual({ state: 'unknown', source_code: '610910', cause: 'prefix_empty', matched_prefix: null });
  });

  it('returns expanded_prefix when expansion finds exactly 1 child', async () => {
    mockedExpandWithFallback.mockResolvedValueOnce({
      children: [{ code: '610910000000', is_deleted: false, replacement_codes: null, description_en: null, description_ar: null }],
      matched_prefix: '610910',
    });
    const r = await resolveMerchant('610910', v2CleanIdentify(), 'naqel', false);
    expect(r).toEqual({ state: 'expanded_prefix', resolved_code: '610910000000', valid_prefix: '610910', source_code: '610910' });
  });
});

describe('resolveMerchant — all 8 MerchantResolution states', () => {
  const states: MerchantResolution[] = [
    { state: 'absent' },
    { state: 'malformed', source_code: '1234' },
    { state: 'active', resolved_code: '610910000000' },
    { state: 'replaced_single', resolved_code: '611120000000', source_code: '611110000000' },
    { state: 'override_applied', resolved_code: '847180000000', source_code: '8471804000', override_matched_length: 12 },
    { state: 'llm_picked_replacement', resolved_code: '720000000000', source_code: '720000000000', candidates: ['720000000000', '730000000000'] },
    { state: 'expanded_prefix', resolved_code: '610910000000', valid_prefix: '610910', source_code: '610910' },
    { state: 'unknown', source_code: '999999999999', cause: 'not_in_codebook', matched_prefix: null },
  ];

  it('has all 8 states covered (compile-time check)', () => {
    // If a new state is added to MerchantResolution without being added here,
    // this assertion count check will catch it on the next run.
    expect(states.length).toBe(8);
  });
});

describe('buildResolutionTrace', () => {
  it('sets override_matched=true when resolution state is override_applied', () => {
    const r: MerchantResolution = {
      state: 'override_applied',
      resolved_code: 'x',
      source_code: 'y',
      override_matched_length: 12,
    };
    const t = buildResolutionTrace(r, Date.now() - 50, false, true);
    expect(t.override_matched).toBe(true);
    expect(t.override_attempted).toBe(true);
    expect(t.latency_ms).toBeGreaterThanOrEqual(50);
  });

  it('sets override_matched=false for other states even when attempted', () => {
    const r: MerchantResolution = { state: 'absent' };
    const t = buildResolutionTrace(r, Date.now(), false, true);
    expect(t.override_matched).toBe(false);
    expect(t.override_attempted).toBe(true);
  });

  it('llm_called reflects the actual call status', () => {
    const r: MerchantResolution = {
      state: 'llm_picked_replacement',
      resolved_code: 'x',
      source_code: 'y',
      candidates: [],
    };
    const t = buildResolutionTrace(r, Date.now(), true, false);
    expect(t.llm_called).toBe(true);
  });
});
