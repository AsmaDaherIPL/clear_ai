/**
 * Unit tests for the picker confidence calculator and the conflict-type
 * gate that demotes low-confidence CONTRADICTION outcomes to AMBIGUOUS.
 *
 * The gate is the row-135 ("TORY 45 → Shell oil") fix: 3-token gibberish
 * descriptions where the picker confidently lands in the wrong chapter,
 * overriding a correct merchant code. Pre-gate, that produced wrong final
 * codes; post-gate, the merchant code wins at LOW confidence.
 */
import { describe, it, expect } from 'vitest';
import {
  computePickerConfidence,
  countTokens,
  pickedHeading,
} from '../../src/modules/pipeline/classify/description-classifier/picker/picker-confidence.js';
import { classifyConflict } from '../../src/modules/pipeline/classify/reconciliation/conflict-type.js';
import type {
  AnnotatedCandidate,
  CandidateFitVerdict,
  ConsistencyVerdict,
  DescriptionClassifierResult,
  CodeResolverResult,
} from '../../src/modules/pipeline/shared/pipeline.types.js';

function ac(code: string, fit: CandidateFitVerdict, rrf = 0.05): AnnotatedCandidate {
  return { code, description_en: code, description_ar: null, rrf_score: rrf, fit, rationale: 't' };
}

function trackA(opts: {
  candidates?: AnnotatedCandidate[];
  picker_confidence?: number | null;
  threshold_failed?: boolean;
}): DescriptionClassifierResult {
  return {
    annotated_candidates: opts.candidates ?? [],
    threshold_failed: opts.threshold_failed ?? false,
    no_fit: !(opts.candidates ?? []).some((c) => c.fit === 'fits' || c.fit === 'partial'),
    interpretation_stage: 'cleaned',
    effective_description: 'test',
    research: null,
    web_research: null,
    inferred_chapters: [],
    prefilter_aborted: false,
    picker_confidence: opts.picker_confidence ?? null,
  };
}

function trackB(opts: {
  resolved_code?: string | null;
  valid_prefix?: string | null;
  consistency_verdict?: ConsistencyVerdict;
}): CodeResolverResult {
  return {
    raw_merchant_code: '640420',
    resolved_code: opts.resolved_code ?? null,
    resolution: 'passthrough',
    override_applied: false,
    override_target_code: null,
    codebook_state: 'active',
    llm_context: null,
    consistency_verdict: opts.consistency_verdict ?? 'consistent',
    valid_prefix: opts.valid_prefix ?? null,
    subtree_candidates: [],
  };
}

describe('countTokens', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countTokens('hello world')).toBe(2);
    expect(countTokens('TORY 45')).toBe(2);
  });

  it('splits on punctuation', () => {
    expect(countTokens('a, b; c.')).toBe(3);
    expect(countTokens('foo-bar')).toBe(2);
  });

  it('handles empty/whitespace input', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('   ')).toBe(0);
  });
});

describe('pickedHeading', () => {
  it('returns first 4 digits of the top fits candidate', () => {
    expect(pickedHeading([ac('640420000000', 'fits'), ac('271019950005', 'partial')])).toBe('6404');
  });

  it('falls back to partial when no fits exists', () => {
    expect(pickedHeading([ac('271019950005', 'partial'), ac('640420000000', 'does_not_fit')])).toBe('2710');
  });

  it('returns null when no positive candidate exists', () => {
    expect(pickedHeading([ac('123456789012', 'does_not_fit')])).toBeNull();
  });
});

describe('computePickerConfidence', () => {
  it('returns null when there are no candidates', () => {
    expect(
      computePickerConfidence({
        candidates: [],
        leafCountInPickedHeading: null,
        effectiveDescriptionTokens: 5,
      }),
    ).toBeNull();
  });

  it('returns 0 when all candidates are does_not_fit', () => {
    expect(
      computePickerConfidence({
        candidates: [ac('a', 'does_not_fit'), ac('b', 'does_not_fit')],
        leafCountInPickedHeading: 50,
        effectiveDescriptionTokens: 5,
      }),
    ).toBe(0);
  });

  it('scores a single fits among many does_not_fit lower than several fits', () => {
    const oneFits = computePickerConfidence({
      candidates: [ac('a', 'fits'), ac('b', 'does_not_fit'), ac('c', 'does_not_fit')],
      leafCountInPickedHeading: 10,
      effectiveDescriptionTokens: 5,
    });
    const manyFits = computePickerConfidence({
      candidates: [ac('a', 'fits'), ac('b', 'fits'), ac('c', 'fits')],
      leafCountInPickedHeading: 10,
      effectiveDescriptionTokens: 5,
    });
    expect(oneFits).toBeLessThan(manyFits!);
  });

  it('applies a fan-out penalty for large leaf spaces', () => {
    const small = computePickerConfidence({
      candidates: [ac('a', 'fits')],
      leafCountInPickedHeading: 10,
      effectiveDescriptionTokens: 5,
    });
    const huge = computePickerConfidence({
      candidates: [ac('a', 'fits')],
      leafCountInPickedHeading: 600,
      effectiveDescriptionTokens: 5,
    });
    expect(huge).toBeLessThan(small!);
  });

  it('applies a thinness penalty for short descriptions', () => {
    const thin = computePickerConfidence({
      candidates: [ac('a', 'fits')],
      leafCountInPickedHeading: 10,
      effectiveDescriptionTokens: 2,
    });
    const rich = computePickerConfidence({
      candidates: [ac('a', 'fits')],
      leafCountInPickedHeading: 10,
      effectiveDescriptionTokens: 8,
    });
    expect(thin).toBeLessThan(rich!);
  });

  it('row-135 TORY 45 lands below the 0.30 gate', () => {
    // Picker emits 1 `fits` on Ch 27 petroleum out of 12 candidates,
    // most others does_not_fit. Description is 2 tokens. Ch 27 has ~200
    // leaves under heading 2710. Expected to fall well below 0.30.
    const conf = computePickerConfidence({
      candidates: [
        ac('271019950005', 'fits'),
        ...Array.from({ length: 11 }, (_, i) => ac(`other${i}`, 'does_not_fit')),
      ],
      leafCountInPickedHeading: 200,
      effectiveDescriptionTokens: 2,
    });
    expect(conf).toBeGreaterThan(0);
    expect(conf).toBeLessThan(0.30);
  });

  it('strong agreement on a rich description scores high', () => {
    // Several fits, small leaf space, full sentence.
    const conf = computePickerConfidence({
      candidates: [ac('a', 'fits'), ac('b', 'fits'), ac('c', 'fits')],
      leafCountInPickedHeading: 8,
      effectiveDescriptionTokens: 10,
    });
    expect(conf).toBeGreaterThan(0.8);
  });

  it('treats unknown leaf count as no penalty', () => {
    const known = computePickerConfidence({
      candidates: [ac('a', 'fits')],
      leafCountInPickedHeading: 10,
      effectiveDescriptionTokens: 8,
    });
    const unknown = computePickerConfidence({
      candidates: [ac('a', 'fits')],
      leafCountInPickedHeading: null,
      effectiveDescriptionTokens: 8,
    });
    expect(known).toBe(unknown);
  });
});

describe('classifyConflict — picker-confidence gate', () => {
  it('demotes CONTRADICTION to AMBIGUOUS when picker_confidence is below the gate', () => {
    // Track A confidently picks a wrong-chapter leaf with low confidence;
    // Track B has a 6-digit merchant prefix hit. Pre-gate this would have
    // been CONTRADICTION (Track A wins, merchant overridden). Gate fires.
    const a = trackA({
      candidates: [ac('271019950005', 'fits')], // Ch 27 petroleum
      picker_confidence: 0.05,
    });
    const b = trackB({
      resolved_code: '640420000000', // Ch 64 footwear
      valid_prefix: '640420',
    });
    expect(classifyConflict(a, b)).toBe('AMBIGUOUS');
  });

  it('keeps CONTRADICTION when picker_confidence is above the gate', () => {
    const a = trackA({
      candidates: [ac('271019950005', 'fits')],
      picker_confidence: 0.6,
    });
    const b = trackB({
      resolved_code: '640420000000',
      valid_prefix: '640420',
    });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  it('does NOT fire the gate when picker_confidence is null', () => {
    // Null means "no scoreable candidates" (threshold_failed path). The
    // gate should not silently demote the verdict in that case.
    const a = trackA({
      candidates: [ac('271019950005', 'fits')],
      picker_confidence: null,
    });
    const b = trackB({
      resolved_code: '640420000000',
      valid_prefix: '640420',
    });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  it('does NOT fire the gate when valid_prefix is below 6 digits', () => {
    // Short merchant prefix (4 digits = heading-only). Not strong enough
    // for the gate to override Track A; original CONTRADICTION stands.
    const a = trackA({
      candidates: [ac('271019950005', 'fits')],
      picker_confidence: 0.05,
    });
    const b = trackB({
      resolved_code: '640400000000',
      valid_prefix: '6404',
    });
    expect(classifyConflict(a, b)).toBe('CONTRADICTION');
  });

  it('does NOT fire the gate when merchant code is absent', () => {
    const a = trackA({
      candidates: [ac('271019950005', 'fits')],
      picker_confidence: 0.05,
    });
    const b = trackB({ resolved_code: null, valid_prefix: null });
    // With no merchant code, route stays on Track A as AGREEMENT (single_a).
    expect(classifyConflict(a, b)).toBe('AGREEMENT');
  });
});
