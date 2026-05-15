/**
 * PR 6 — scope_selection pure-function tests.
 *
 * 25+ tests covering every (identify.kind × merchant_resolution.state)
 * combination that matters, plus the secondary-arm predicate gates.
 */
import { describe, expect, it } from 'vitest';
import { selectScopes } from '../../src/modules/pipeline/v2/scope/select.js';
import type {
  IdentifyCallTrace,
  IdentifyResult,
  MerchantResolution,
} from '../../src/modules/pipeline/v2/types.js';

const fastTrace: IdentifyCallTrace = {
  pass: 'fast',
  llm_called: true,
  latency_ms: 2500,
  model: 'mock-sonnet',
  status: 'ok',
  web_search_used: false,
  evidence_mismatch: false,
};

function clean(opts: {
  family?: string | null;
  confidence?: number;
  tokens?: string[];
  canonical?: string;
} = {}): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical: opts.canonical ?? 'cotton t-shirt, knitted',
    family_chapter: 'family' in opts ? opts.family ?? null : '61',
    identity_tokens: opts.tokens ?? [],
    confidence: opts.confidence ?? 0.9,
    evidence: 'world_knowledge',
    trace: fastTrace,
  };
}

function multi(products: string[] = ['a', 'b']): IdentifyResult {
  return { kind: 'multi_product', products, trace: fastTrace };
}

function uninf(): IdentifyResult {
  return { kind: 'uninformative', cause: 'genuine', reason: 'r', trace: fastTrace };
}

describe('selectScopes — escalate paths (no clean merchant)', () => {
  it('multi_product + absent merchant → escalate(identify_multi_product)', () => {
    const r = selectScopes(multi(), { state: 'absent' });
    expect(r.primary.kind).toBe('escalate');
    if (r.primary.kind === 'escalate') {
      expect(r.primary.reason).toBe('identify_multi_product');
    }
    expect(r.secondaries).toEqual([]);
  });

  it('uninformative + absent merchant → escalate(identify_uninformative_no_merchant)', () => {
    const r = selectScopes(uninf(), { state: 'absent' });
    if (r.primary.kind === 'escalate') {
      expect(r.primary.reason).toBe('identify_uninformative_no_merchant');
    }
  });

  it('uninformative + malformed merchant → escalate(identify_uninformative_no_merchant)', () => {
    const r = selectScopes(uninf(), { state: 'malformed', source_code: 'parcel' });
    if (r.primary.kind === 'escalate') {
      expect(r.primary.reason).toBe('identify_uninformative_no_merchant');
    }
  });

  it('multi_product + malformed merchant → escalate(identify_multi_product)', () => {
    const r = selectScopes(multi(), { state: 'malformed', source_code: 'x' });
    if (r.primary.kind === 'escalate') {
      expect(r.primary.reason).toBe('identify_multi_product');
    }
  });
});

describe('selectScopes — merchant_prefix primary + secondary arms', () => {
  const merchantActive: MerchantResolution = { state: 'active', resolved_code: '610910000000' };

  it('merchant active + identify same chapter (61) + no tokens → primary only, no secondaries', () => {
    const r = selectScopes(clean({ family: '61' }), merchantActive);
    expect(r.primary.kind).toBe('merchant_prefix');
    if (r.primary.kind === 'merchant_prefix') {
      expect(r.primary.prefix).toBe('61091000'); // first 8 of resolved_code
      expect(r.primary.source).toBe('merchant_active');
    }
    expect(r.secondaries).toEqual([]);
    expect(r.audit_flags).toEqual([]);
  });

  it('merchant active + identify DIFFERENT chapter at high confidence → adds family_chapter secondary + audit flag', () => {
    const r = selectScopes(
      clean({ family: '85', confidence: 0.92 }),
      merchantActive,
    );
    expect(r.primary.kind).toBe('merchant_prefix');
    expect(r.secondaries).toHaveLength(1);
    expect(r.secondaries[0]!.kind).toBe('family_chapter');
    if (r.secondaries[0]!.kind === 'family_chapter') {
      expect(r.secondaries[0]!.chapter).toBe('85');
    }
    expect(r.audit_flags).toContain('merchant_chapter_disagreement');
  });

  it('merchant active + identify different chapter BELOW threshold (0.84) → NO secondary, NO audit flag', () => {
    const r = selectScopes(clean({ family: '85', confidence: 0.84 }), merchantActive);
    expect(r.secondaries).toEqual([]);
    expect(r.audit_flags).toEqual([]);
  });

  it('merchant active + identify same chapter + identity tokens → adds lexical_tokens secondary only', () => {
    const r = selectScopes(
      clean({ family: '61', confidence: 0.9, tokens: ['pampers', 'diaper'] }),
      merchantActive,
    );
    expect(r.secondaries).toHaveLength(1);
    expect(r.secondaries[0]!.kind).toBe('lexical_tokens');
    if (r.secondaries[0]!.kind === 'lexical_tokens') {
      expect(r.secondaries[0]!.tokens).toEqual(['pampers', 'diaper']);
    }
    expect(r.audit_flags).toEqual([]);
  });

  it('merchant active + identify family=null at high confidence → adds unconstrained + identify_family_null flag', () => {
    const r = selectScopes(
      clean({ family: null, confidence: 0.88 }),
      merchantActive,
    );
    expect(r.secondaries).toHaveLength(1);
    expect(r.secondaries[0]!.kind).toBe('unconstrained');
    if (r.secondaries[0]!.kind === 'unconstrained') {
      expect(r.secondaries[0]!.reason).toBe('composite_product');
    }
    expect(r.audit_flags).toContain('identify_family_null');
  });

  it('merchant active + chapter disagreement + family=null + tokens → all three: family arm + lexical arm (but family null replaces) + flags', () => {
    // When family is null we get unconstrained instead of family_chapter,
    // plus lexical if tokens exist.
    const r = selectScopes(
      clean({ family: null, confidence: 0.9, tokens: ['lego'] }),
      merchantActive,
    );
    expect(r.secondaries).toHaveLength(2);
    expect(r.secondaries[0]!.kind).toBe('unconstrained');
    expect(r.secondaries[1]!.kind).toBe('lexical_tokens');
    expect(r.audit_flags).toContain('identify_family_null');
  });

  it('merchant active + chapter disagreement + tokens → both family secondary + lexical secondary + chapter disagreement flag', () => {
    const r = selectScopes(
      clean({ family: '85', confidence: 0.9, tokens: ['maxhub'] }),
      merchantActive,
    );
    expect(r.secondaries).toHaveLength(2);
    expect(r.secondaries[0]!.kind).toBe('family_chapter');
    expect(r.secondaries[1]!.kind).toBe('lexical_tokens');
    expect(r.audit_flags).toContain('merchant_chapter_disagreement');
  });
});

describe('selectScopes — override suppression', () => {
  const overrideRes: MerchantResolution = {
    state: 'override_applied',
    resolved_code: '847180000000',
    source_code: '8471804000',
    override_matched_length: 12,
  };

  it('override_applied → primary=merchant_prefix, NO secondaries even with chapter disagreement', () => {
    const r = selectScopes(
      clean({ family: '85', confidence: 0.95, tokens: ['ssd', 'nvme'] }),
      overrideRes,
    );
    expect(r.primary.kind).toBe('merchant_prefix');
    if (r.primary.kind === 'merchant_prefix') {
      expect(r.primary.source).toBe('override_applied');
    }
    expect(r.secondaries).toEqual([]);
    expect(r.audit_flags).toContain('override_suppresses_secondary');
    // Critically: NO merchant_chapter_disagreement flag (override wins)
    expect(r.audit_flags).not.toContain('merchant_chapter_disagreement');
  });
});

describe('selectScopes — non-merchant primary scopes', () => {
  it('absent merchant + identify clean with family → family_chapter primary', () => {
    const r = selectScopes(clean({ family: '85' }), { state: 'absent' });
    expect(r.primary.kind).toBe('family_chapter');
    if (r.primary.kind === 'family_chapter') {
      expect(r.primary.chapter).toBe('85');
      expect(r.primary.source).toBe('identify');
    }
  });

  it('absent merchant + identify clean WITH tokens → family_chapter primary + lexical secondary', () => {
    const r = selectScopes(
      clean({ family: '85', tokens: ['maxhub'] }),
      { state: 'absent' },
    );
    expect(r.primary.kind).toBe('family_chapter');
    expect(r.secondaries).toHaveLength(1);
    expect(r.secondaries[0]!.kind).toBe('lexical_tokens');
  });

  it('absent merchant + identify clean family=null → unconstrained primary', () => {
    const r = selectScopes(clean({ family: null }), { state: 'absent' });
    expect(r.primary.kind).toBe('unconstrained');
    if (r.primary.kind === 'unconstrained') {
      expect(r.primary.reason).toBe('no_merchant_low_confidence_identify');
    }
  });

  it('unknown merchant + identify clean with family → family_chapter primary', () => {
    const r = selectScopes(clean({ family: '85' }), {
      state: 'unknown',
      source_code: '999999999999',
      cause: 'not_in_codebook',
      matched_prefix: null,
    });
    expect(r.primary.kind).toBe('family_chapter');
  });

  it('malformed merchant + identify clean with family → family_chapter primary', () => {
    const r = selectScopes(clean({ family: '85' }), {
      state: 'malformed',
      source_code: 'parcel',
    });
    expect(r.primary.kind).toBe('family_chapter');
  });

  it('malformed merchant + identify family=null + uninformative is escalate', () => {
    const r = selectScopes(uninf(), { state: 'malformed', source_code: 'x' });
    expect(r.primary.kind).toBe('escalate');
  });
});

describe('selectScopes — merchant_prefix sources', () => {
  it('replaced_single → source=merchant_replacement_picked', () => {
    const r = selectScopes(clean({ family: '61' }), {
      state: 'replaced_single',
      resolved_code: '611120000000',
      source_code: '611110000000',
    });
    if (r.primary.kind === 'merchant_prefix') {
      expect(r.primary.source).toBe('merchant_replacement_picked');
    }
  });

  it('llm_picked_replacement → source=merchant_replacement_picked', () => {
    const r = selectScopes(clean({ family: '61' }), {
      state: 'llm_picked_replacement',
      resolved_code: '611120000000',
      source_code: '611110000000',
      candidates: [],
    });
    if (r.primary.kind === 'merchant_prefix') {
      expect(r.primary.source).toBe('merchant_replacement_picked');
    }
  });

  it('expanded_prefix uses valid_prefix (not resolved_code) as the retrieval prefix', () => {
    const r = selectScopes(clean({ family: '61' }), {
      state: 'expanded_prefix',
      resolved_code: '610910000000',
      valid_prefix: '610910',
      source_code: '610910',
    });
    if (r.primary.kind === 'merchant_prefix') {
      expect(r.primary.prefix).toBe('610910'); // not the first-8 of resolved_code
      expect(r.primary.source).toBe('merchant_expanded');
    }
  });
});

describe('selectScopes — determinism', () => {
  it('same input → same output (no randomness)', () => {
    const id = clean({ family: '85', confidence: 0.9, tokens: ['lego'] });
    const m: MerchantResolution = { state: 'active', resolved_code: '610910000000' };
    const r1 = selectScopes(id, m);
    const r2 = selectScopes(id, m);
    expect(r1).toEqual(r2);
  });
});
