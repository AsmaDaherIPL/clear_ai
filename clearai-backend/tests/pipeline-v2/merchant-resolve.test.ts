/**
 * PR 5 — merchant_resolution wrapper tests.
 *
 * The underlying legacy resolveMerchantCode has 18 tests of its own
 * under tests/anchored/resolve-merchant.test.ts. These tests verify
 * the v2 wrapper specifically:
 *   - v2 IdentifyResult is correctly converted to legacy shape
 *   - all 8 MerchantResolution states pass through unchanged
 *   - buildResolutionTrace populates the trace correctly
 *
 * The legacy implementation is mocked so these tests don't hit DB.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/modules/pipeline/constrain/resolve-merchant.js', () => ({
  resolveMerchantCode: vi.fn(),
}));

import {
  resolveMerchant,
  buildResolutionTrace,
} from '../../src/modules/pipeline/v2/merchant/resolve.js';
import { resolveMerchantCode as resolveMerchantCodeLegacy } from '../../src/modules/pipeline/constrain/resolve-merchant.js';
import type {
  IdentifyResult,
  MerchantResolution,
} from '../../src/modules/pipeline/v2/types.js';

const mockedLegacy = vi.mocked(resolveMerchantCodeLegacy);

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

beforeEach(() => mockedLegacy.mockReset());

describe('resolveMerchant — wrapper conversion', () => {
  it('converts v2 clean_product IdentifyResult to legacy shape (trace minus pass field)', async () => {
    mockedLegacy.mockResolvedValueOnce({ state: 'absent' });
    await resolveMerchant(null, v2CleanIdentify(), 'naqel', true);
    const legacyArg = mockedLegacy.mock.calls[0]![1];
    expect(legacyArg.kind).toBe('clean_product');
    if (legacyArg.kind === 'clean_product') {
      expect(legacyArg.canonical).toBe('cotton t-shirt, knitted');
      expect(legacyArg.family_chapter).toBe('61');
      // Legacy trace shape has no 'pass' field
      expect((legacyArg.trace as Record<string, unknown>).pass).toBeUndefined();
      expect(legacyArg.trace.web_search_used).toBe(false);
    }
  });

  it('converts v2 uninformative IdentifyResult to legacy shape', async () => {
    mockedLegacy.mockResolvedValueOnce({ state: 'absent' });
    await resolveMerchant('parcel', v2UninformativeIdentify(), 'naqel', true);
    const legacyArg = mockedLegacy.mock.calls[0]![1];
    expect(legacyArg.kind).toBe('uninformative');
    if (legacyArg.kind === 'uninformative') {
      expect(legacyArg.cause).toBe('genuine');
      expect(legacyArg.reason).toBe('placeholder');
    }
  });

  it('passes raw_code, operator_slug, overrides_enabled through unchanged', async () => {
    mockedLegacy.mockResolvedValueOnce({ state: 'absent' });
    await resolveMerchant('610910000000', v2CleanIdentify(), 'naqel', false);
    expect(mockedLegacy).toHaveBeenCalledWith(
      '610910000000',
      expect.any(Object),
      'naqel',
      false,
    );
  });

  it('returns the legacy MerchantResolution unchanged', async () => {
    const expected: MerchantResolution = {
      state: 'expanded_prefix',
      resolved_code: '610910000000',
      valid_prefix: '610910',
      source_code: '610910',
    };
    mockedLegacy.mockResolvedValueOnce(expected);
    const r = await resolveMerchant('610910', v2CleanIdentify(), 'naqel', true);
    expect(r).toEqual(expected);
  });
});

describe('resolveMerchant — all 8 MerchantResolution states pass through', () => {
  const states: MerchantResolution[] = [
    { state: 'absent' },
    { state: 'malformed', source_code: 'parcel' },
    { state: 'active', resolved_code: '610910000000' },
    { state: 'replaced_single', resolved_code: '611120000000', source_code: '611110000000' },
    {
      state: 'override_applied',
      resolved_code: '847180000000',
      source_code: '8471804000',
      override_matched_length: 12,
    },
    {
      state: 'llm_picked_replacement',
      resolved_code: '720000000000',
      source_code: '720000000000',
      candidates: ['720000000000', '730000000000'],
    },
    {
      state: 'expanded_prefix',
      resolved_code: '610910000000',
      valid_prefix: '610910',
      source_code: '610910',
    },
    {
      state: 'unknown',
      source_code: '999999999999',
      cause: 'not_in_codebook',
      matched_prefix: null,
    },
  ];

  for (const state of states) {
    it(`passes through state=${state.state}`, async () => {
      mockedLegacy.mockResolvedValueOnce(state);
      const r = await resolveMerchant('any', v2CleanIdentify(), 'naqel', true);
      expect(r).toEqual(state);
    });
  }
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
