/**
 * PR 10 — verifier tests.
 *
 * Pure function. No mocks. Covers each rule independently + combinations.
 */
import { describe, expect, it } from 'vitest';
import { verifyClassification } from '../../src/modules/pipeline/v2/pick/verify.js';
import type {
  IdentifyCallTrace,
  IdentifyResult,
  PickAccepted,
  PickCallTrace,
} from '../../src/modules/pipeline/v2/types.js';

const fastTrace: IdentifyCallTrace = {
  pass: 'fast',
  llm_called: true,
  latency_ms: 2000,
  model: 'mock-sonnet',
  status: 'ok',
  web_search_used: false,
  evidence_mismatch: false,
};

const pickTrace: PickCallTrace = {
  llm_called: true,
  latency_ms: 5000,
  model: 'mock-sonnet',
  status: 'ok',
  candidate_count: 8,
  audit_flag: false,
};

function id(opts: { family?: string | null; confidence?: number } = {}): IdentifyResult {
  return {
    kind: 'clean_product',
    canonical: 'cotton t-shirt',
    family_chapter: 'family' in opts ? opts.family ?? null : '61',
    identity_tokens: [],
    confidence: opts.confidence ?? 0.9,
    evidence: 'world_knowledge',
    trace: fastTrace,
  };
}

function pick(opts: { code?: string; fit?: 'fits' | 'partial'; confidence?: number } = {}): PickAccepted {
  return {
    kind: 'accepted',
    final_code: opts.code ?? '610910000000',
    fit: opts.fit ?? 'fits',
    confidence: opts.confidence ?? 0.85,
    gir_applied: 'GIR 1',
    verdict_population: { fits: 1, partial: 0, does_not_fit: 0 },
    picked_from_arm: 'merchant_prefix',
    merchant_chapter_disagreement: false,
    candidate_count_by_arm: { merchant_prefix: 1 },
    trace: pickTrace,
  };
}

describe('verifyClassification — PASS cases', () => {
  it('returns PASS when both rules pass', () => {
    const r = verifyClassification(pick(), id({ family: '61', confidence: 0.95 }));
    expect(r.result).toBe('PASS');
    expect(r.rules_triggered).toEqual([]);
  });

  it('PASS when identify low-confidence chapter disagrees (below 0.90 threshold)', () => {
    const r = verifyClassification(
      pick({ code: '610910000000' }),
      id({ family: '85', confidence: 0.85 }), // chapter disagrees but confidence at threshold (not above)
    );
    expect(r.result).toBe('PASS');
  });

  it('PASS when identify has null family_chapter (composite product)', () => {
    const r = verifyClassification(
      pick({ code: '610910000000' }),
      id({ family: null, confidence: 0.95 }),
    );
    expect(r.result).toBe('PASS');
  });

  it('PASS when identify is uninformative', () => {
    const r = verifyClassification(pick(), {
      kind: 'uninformative',
      cause: 'genuine',
      reason: 'r',
      trace: fastTrace,
    });
    expect(r.result).toBe('PASS');
  });

  it('PASS when picker fits + identify high-confidence + same chapter', () => {
    const r = verifyClassification(
      pick({ code: '852852000000' }),
      id({ family: '85', confidence: 0.95 }),
    );
    expect(r.result).toBe('PASS');
  });
});

describe('verifyClassification — Rule 1: identify_chapter_disagreement', () => {
  it('UNCERTAIN when identify confidence ≥ 0.90 + chapters disagree', () => {
    const r = verifyClassification(
      pick({ code: '610910000000' }), // chapter 61
      id({ family: '85', confidence: 0.92 }), // chapter 85
    );
    expect(r.result).toBe('UNCERTAIN');
    expect(r.rules_triggered).toContain('identify_chapter_disagreement');
  });

  it('rule 1 fires at exactly 0.90 confidence (boundary inclusive)', () => {
    const r = verifyClassification(
      pick({ code: '610910000000' }),
      id({ family: '85', confidence: 0.90 }),
    );
    expect(r.rules_triggered).toContain('identify_chapter_disagreement');
  });

  it('rule 1 does NOT fire below 0.90 (strict threshold)', () => {
    const r = verifyClassification(
      pick({ code: '610910000000' }),
      id({ family: '85', confidence: 0.89 }),
    );
    expect(r.rules_triggered).not.toContain('identify_chapter_disagreement');
    expect(r.result).toBe('PASS');
  });

  it('rule 1 does NOT fire when identify.family_chapter is null', () => {
    const r = verifyClassification(
      pick({ code: '610910000000' }),
      id({ family: null, confidence: 0.95 }),
    );
    expect(r.rules_triggered).not.toContain('identify_chapter_disagreement');
  });
});

describe('verifyClassification — Rule 2: confidence_inversion', () => {
  it('UNCERTAIN when picker partial + identify very high confidence', () => {
    const r = verifyClassification(
      pick({ fit: 'partial', confidence: 0.55 }),
      id({ family: '61', confidence: 0.93 }),
    );
    expect(r.result).toBe('UNCERTAIN');
    expect(r.rules_triggered).toContain('confidence_inversion');
  });

  it('rule 2 boundary: picker = 0.55 (inclusive) + identify = 0.92 (inclusive)', () => {
    const r = verifyClassification(
      pick({ confidence: 0.55 }),
      id({ confidence: 0.92 }),
    );
    expect(r.rules_triggered).toContain('confidence_inversion');
  });

  it('rule 2 does NOT fire when picker confidence above 0.55', () => {
    const r = verifyClassification(
      pick({ fit: 'fits', confidence: 0.85 }),
      id({ confidence: 0.95 }),
    );
    expect(r.rules_triggered).not.toContain('confidence_inversion');
  });

  it('rule 2 does NOT fire when identify confidence below 0.92', () => {
    const r = verifyClassification(
      pick({ fit: 'partial', confidence: 0.55 }),
      id({ confidence: 0.91 }),
    );
    expect(r.rules_triggered).not.toContain('confidence_inversion');
  });

  it('rule 2 does NOT fire when identify is not clean_product', () => {
    const r = verifyClassification(pick({ fit: 'partial', confidence: 0.55 }), {
      kind: 'uninformative',
      cause: 'genuine',
      reason: 'r',
      trace: fastTrace,
    });
    expect(r.rules_triggered).not.toContain('confidence_inversion');
  });
});

describe('verifyClassification — both rules', () => {
  it('UNCERTAIN with both rules triggered', () => {
    const r = verifyClassification(
      pick({ code: '852852000000', fit: 'partial', confidence: 0.55 }), // chapter 85
      id({ family: '61', confidence: 0.95 }), // chapter 61, very high conf
    );
    expect(r.result).toBe('UNCERTAIN');
    expect(r.rules_triggered).toContain('identify_chapter_disagreement');
    expect(r.rules_triggered).toContain('confidence_inversion');
    expect(r.rules_triggered).toHaveLength(2);
  });
});

describe('verifyClassification — never overrides pick.final_code (property)', () => {
  it('output is structurally separate from pick (no shared reference)', () => {
    const p = pick();
    const originalCode = p.final_code;
    verifyClassification(p, id({ family: '85', confidence: 0.95 }));
    // pick.final_code unchanged — verifier is pure
    expect(p.final_code).toBe(originalCode);
  });
});

describe('verifyClassification — determinism', () => {
  it('same input → same output', () => {
    const p = pick();
    const i = id({ family: '85', confidence: 0.95 });
    const r1 = verifyClassification(p, i);
    const r2 = verifyClassification(p, i);
    expect(r1).toEqual(r2);
  });
});
