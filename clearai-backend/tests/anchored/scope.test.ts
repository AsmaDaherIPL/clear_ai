/**
 * PR-A-3 — scopeFrom (deterministic retrieval-scope selector).
 *
 * Pure function over typed inputs. Replaces the 11-rule conflict-type
 * classifier with a 4-rule decision over (identify, merchant_resolution).
 *
 * Tests cover the cross-product of (identify_kind, identify.confidence,
 * identify.family_chapter, resolution.state) for the cases Master Table 1
 * lists.
 */
import { describe, expect, it } from 'vitest';
import { scopeFrom } from '../../src/modules/pipeline/constrain/scope.js';
import type {
  IdentifyResult,
  IdentifyCallTrace,
} from '../../src/modules/pipeline/identify/identify.types.js';
import type { MerchantResolution } from '../../src/modules/pipeline/constrain/constrain.types.js';

// ───────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────

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

function cleanProduct(opts: {
  canonical?: string;
  family_chapter?: string | null;
  confidence?: number;
  identity_tokens?: string[];
  evidence?: 'web' | 'world_knowledge';
} = {}): IdentifyResult {
  // family_chapter is `string | null` — must distinguish explicit
  // null (caller wants no family hint) from omitted (default '61').
  // `??` is wrong here because it collapses null and undefined.
  const family_chapter =
    'family_chapter' in opts ? opts.family_chapter! : '61';
  return {
    kind: 'clean_product',
    canonical: opts.canonical ?? 'cotton t-shirt',
    family_chapter,
    identity_tokens: opts.identity_tokens ?? [],
    confidence: opts.confidence ?? 0.9,
    evidence: opts.evidence ?? 'world_knowledge',
    trace: trace(),
  };
}

function multiProduct(products: string[] = ['a', 'b']): IdentifyResult {
  return { kind: 'multi_product', products, trace: trace() };
}

function uninformative(cause: 'genuine' | 'short_circuit' | 'transport' | 'parse' | 'contract' = 'genuine'): IdentifyResult {
  return {
    kind: 'uninformative',
    reason: 'test',
    cause,
    trace: trace(),
  };
}

// MerchantResolution fixtures.
const M = {
  absent: (): MerchantResolution => ({ state: 'absent' }),
  malformed: (): MerchantResolution => ({ state: 'malformed', source_code: 'xyz' }),
  active: (code = '610910000000'): MerchantResolution => ({ state: 'active', resolved_code: code }),
  replacedSingle: (code = '610910000000', source = '610999999999'): MerchantResolution => ({
    state: 'replaced_single',
    resolved_code: code,
    source_code: source,
  }),
  override: (code = '610910000000', source = '610910'): MerchantResolution => ({
    state: 'override_applied',
    resolved_code: code,
    source_code: source,
    override_matched_length: 6,
  }),
  llmPicked: (code = '610910000000', source = '610999999999', candidates = ['610910000000', '610990000000']): MerchantResolution => ({
    state: 'llm_picked_replacement',
    resolved_code: code,
    source_code: source,
    candidates,
  }),
  expanded: (code = '610910000000', prefix = '610910', source = '610910'): MerchantResolution => ({
    state: 'expanded_prefix',
    resolved_code: code,
    valid_prefix: prefix,
    source_code: source,
  }),
  // Unknown with no salvageable prefix (12-digit not in codebook).
  unknown: (): MerchantResolution => ({
    state: 'unknown',
    source_code: 'badcode',
    cause: 'not_in_codebook',
    matched_prefix: null,
  }),
  // Unknown with a salvageable prefix — LLM pick failed but the
  // prefix is real. scope.ts downgrades to merchant_prefix with
  // audit_flag, rather than discarding the merchant anchor.
  unknownWithPrefix: (prefix = '640420'): MerchantResolution => ({
    state: 'unknown',
    source_code: '640420',
    cause: 'llm_pick_failed_prefix',
    matched_prefix: prefix,
  }),
};

// ───────────────────────────────────────────────────────────────────────
// identify=multi_product short-circuits to escalate regardless of merchant
// ───────────────────────────────────────────────────────────────────────

describe('scopeFrom — identify.multi_product', () => {
  it('escalates with reason identify_multi_product regardless of merchant resolution', () => {
    const s1 = scopeFrom(multiProduct(), M.active());
    expect(s1.kind).toBe('escalate');
    if (s1.kind === 'escalate') expect(s1.reason).toBe('identify_multi_product');

    const s2 = scopeFrom(multiProduct(), M.absent());
    expect(s2.kind).toBe('escalate');
  });
});

// ───────────────────────────────────────────────────────────────────────
// identify=uninformative routes by merchant state
// ───────────────────────────────────────────────────────────────────────

describe('scopeFrom — identify.uninformative', () => {
  it('uninformative + merchant absent → escalate identify_uninformative_no_merchant', () => {
    const s = scopeFrom(uninformative(), M.absent());
    expect(s.kind).toBe('escalate');
    if (s.kind === 'escalate') expect(s.reason).toBe('identify_uninformative_no_merchant');
  });

  it('uninformative + merchant active → merchant_prefix with merchant_active source', () => {
    const s = scopeFrom(uninformative(), M.active('640420000000'));
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.prefix).toBe('640420');
      expect(s.source).toBe('merchant_active');
      expect(s.audit_flag).toBe(false);
    }
  });

  it('uninformative + merchant malformed → escalate merchant_malformed_no_family', () => {
    const s = scopeFrom(uninformative(), M.malformed());
    expect(s.kind).toBe('escalate');
    if (s.kind === 'escalate') expect(s.reason).toBe('merchant_malformed_no_family');
  });

  it('uninformative + merchant unknown → unconstrained merchant_unknown_no_family', () => {
    const s = scopeFrom(uninformative(), M.unknown());
    expect(s.kind).toBe('unconstrained');
    if (s.kind === 'unconstrained') expect(s.reason).toBe('merchant_unknown_no_family');
  });
});

// ───────────────────────────────────────────────────────────────────────
// identify=clean_product + merchant active → merchant prefix wins
// ───────────────────────────────────────────────────────────────────────

describe('scopeFrom — clean_product + merchant active', () => {
  it('merchant prefix is the anchor when merchant is active', () => {
    const s = scopeFrom(
      cleanProduct({ family_chapter: '85', confidence: 0.9 }),
      M.active('640420000000'),
    );
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.prefix).toBe('640420');
      expect(s.source).toBe('merchant_active');
    }
  });

  it('override-vs-identify chapter mismatch (high confidence) → identify wins, audit_flag', () => {
    // Operator default 87150010 applied to a vacuum cleaner.
    // identify says vacuum (Ch 85), confidence high.
    // Per memory rule: don't delete dirty override; do override the
    // scope decision for this row + flag for audit.
    const s = scopeFrom(
      cleanProduct({ family_chapter: '85', confidence: 0.9, canonical: 'vacuum cleaner' }),
      M.override('871500100000', '87150010'),
    );
    expect(s.kind).toBe('family_chapter');
    if (s.kind === 'family_chapter') {
      expect(s.chapter).toBe('85');
      expect(s.audit_flag).toBe(true);
    }
  });

  it('override target SAME chapter as identify → merchant_prefix (override), no audit flag', () => {
    const s = scopeFrom(
      cleanProduct({ family_chapter: '95', confidence: 0.9, canonical: 'Lego construction set' }),
      M.override('950330750000', 'lego'),
    );
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.source).toBe('merchant_override');
      expect(s.audit_flag).toBe(false);
    }
  });

  it('low-confidence identify does NOT override merchant chapter mismatch', () => {
    // Row-22 / row-135 pattern: identify is uncertain ("RESY"), merchant is footwear.
    // The merchant code wins even on chapter mismatch when identify is low-confidence.
    const s = scopeFrom(
      cleanProduct({ family_chapter: '27', confidence: 0.2, canonical: 'something' }),
      M.active('640420000000'),
    );
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.prefix).toBe('640420');
      expect(s.audit_flag).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// llm_picked_replacement always carries audit_flag
// ───────────────────────────────────────────────────────────────────────

describe('scopeFrom — llm_picked_replacement audit_flag', () => {
  it('llm_picked_replacement → merchant_prefix with audit_flag=true', () => {
    const s = scopeFrom(cleanProduct(), M.llmPicked('610910000000', '610999999999', ['610910000000', '610990000000']));
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.source).toBe('merchant_replacement_picked');
      expect(s.audit_flag).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// Family chapter fallback when no merchant signal
// ───────────────────────────────────────────────────────────────────────

describe('scopeFrom — family_chapter fallback', () => {
  it('clean_product + merchant absent + identify confident with family → family_chapter', () => {
    const s = scopeFrom(
      cleanProduct({ family_chapter: '85', confidence: 0.85 }),
      M.absent(),
    );
    expect(s.kind).toBe('family_chapter');
    if (s.kind === 'family_chapter') {
      expect(s.chapter).toBe('85');
      expect(s.audit_flag).toBe(false);
    }
  });

  it('clean_product + merchant absent + identify low confidence → unconstrained', () => {
    const s = scopeFrom(
      cleanProduct({ family_chapter: '85', confidence: 0.4 }),
      M.absent(),
    );
    expect(s.kind).toBe('unconstrained');
    if (s.kind === 'unconstrained') {
      expect(s.reason).toBe('no_merchant_low_confidence_identify');
    }
  });

  it('clean_product + merchant absent + identify confident but family null → unconstrained', () => {
    const s = scopeFrom(
      cleanProduct({ family_chapter: null, confidence: 0.85 }),
      M.absent(),
    );
    expect(s.kind).toBe('unconstrained');
  });

  it('clean_product + merchant unknown + identify confident → family_chapter wins', () => {
    const s = scopeFrom(
      cleanProduct({ family_chapter: '95', confidence: 0.9 }),
      M.unknown(),
    );
    expect(s.kind).toBe('family_chapter');
    if (s.kind === 'family_chapter') expect(s.chapter).toBe('95');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Resolution state → scope source mapping
// ───────────────────────────────────────────────────────────────────────

describe('scopeFrom — resolution → source mapping', () => {
  it('replaced_single → merchant_replacement_single', () => {
    const s = scopeFrom(cleanProduct({ confidence: 0.4 }), M.replacedSingle());
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.source).toBe('merchant_replacement_single');
    }
  });

  it('expanded_prefix → merchant_expanded, uses valid_prefix at max granularity', () => {
    // M.expanded has valid_prefix='610910' (HS6). scope should use
    // that exact prefix, not slice resolved_code to 6.
    const s = scopeFrom(cleanProduct({ confidence: 0.4 }), M.expanded());
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.source).toBe('merchant_expanded');
      expect(s.prefix).toBe('610910');
    }
  });

  it('expanded_prefix at HS8 granularity preserves all 8 digits in prefix', () => {
    const resolution = {
      state: 'expanded_prefix' as const,
      resolved_code: '61091000ABCD'.slice(0, 12),
      valid_prefix: '61091000',
      source_code: '61091000',
    };
    const s = scopeFrom(cleanProduct(), resolution);
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.prefix).toBe('61091000');
    }
  });
});

describe('scopeFrom — unknown-with-salvageable-prefix downgrade', () => {
  // When LLM-pick failed but the codebook walk identified a real
  // prefix, scope.ts downgrades to merchant_prefix with audit_flag
  // rather than discarding the merchant signal.
  it('clean_product + unknown with matched_prefix → merchant_prefix (audit_flag) even when identify has confident family', () => {
    const s = scopeFrom(
      cleanProduct({ family_chapter: '85', confidence: 0.9 }),
      M.unknownWithPrefix('640420'),
    );
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.prefix).toBe('640420');
      expect(s.audit_flag).toBe(true);
      expect(s.source).toBe('merchant_replacement_picked');
    }
  });

  it('uninformative + unknown with matched_prefix → merchant_prefix (audit_flag), NOT unconstrained', () => {
    const s = scopeFrom(uninformative(), M.unknownWithPrefix('640420'));
    expect(s.kind).toBe('merchant_prefix');
    if (s.kind === 'merchant_prefix') {
      expect(s.prefix).toBe('640420');
      expect(s.audit_flag).toBe(true);
    }
  });

  it('uninformative + unknown WITHOUT matched_prefix still routes to unconstrained', () => {
    // The non-salvageable causes (not_in_codebook, no_replacements,
    // prefix_empty) genuinely have no merchant anchor; scope stays
    // unconstrained.
    const s = scopeFrom(uninformative(), M.unknown());
    expect(s.kind).toBe('unconstrained');
  });
});
