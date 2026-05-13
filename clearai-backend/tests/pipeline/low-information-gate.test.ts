/**
 * Low-information escalation gate.
 *
 * Pinned scenarios:
 *   - "B6(Black)+Blue case" — researcher fired and gave up, description
 *     is 4 tokens, no web research → escalate.
 *   - "phone case" by itself, researcher recognized → don't escalate;
 *     enriched description is the right signal even when short.
 *   - Researcher never ran (clarity_verdict was 'clear' upstream) → don't
 *     escalate; this gate doesn't second-guess short clear descriptions.
 */
import { describe, it, expect } from 'vitest';
import { shouldEscalateLowInformation } from '../../src/modules/pipeline/pipeline.orchestrator.js';
import type {
  DescriptionClassifierResult,
  DescriptionClassifierResearchDetail,
} from '../../src/modules/pipeline/shared/pipeline.types.js';

function trackA(opts: {
  research?: DescriptionClassifierResearchDetail | null;
  web_research?: DescriptionClassifierResearchDetail | null;
}): DescriptionClassifierResult {
  return {
    annotated_candidates: [],
    threshold_failed: false,
    no_fit: false,
    interpretation_stage: 'cleaned',
    effective_description: 'test',
    research: opts.research ?? null,
    web_research: opts.web_research ?? null,
    inferred_chapters: [],
    prefilter_aborted: false,
    picker_confidence: null,
  };
}

const failedPassthrough: DescriptionClassifierResearchDetail = {
  source: 'failed_passthrough',
  recognised: false,
  enriched_description: 'B6(Black)+Blue case',
  unrecognised_reason: 'insufficient product information to identify physical product',
  evidence_quote: null,
  model: 'claude-sonnet-4-6-clearai-dev',
  latency_ms: 1500,
};

const recognised: DescriptionClassifierResearchDetail = {
  source: 'cheap_llm',
  recognised: true,
  enriched_description: 'protective case for mobile telephones, of plastic',
  unrecognised_reason: null,
  evidence_quote: null,
  model: 'claude-sonnet-4-6-clearai-dev',
  latency_ms: 1500,
};

describe('shouldEscalateLowInformation', () => {
  it('escalates: researcher failed AND description ≤4 tokens', () => {
    // B6(Black)+Blue case: researcher gave up, 4 tokens after stripping
    // punctuation: B6, Black, Blue, case.
    expect(shouldEscalateLowInformation(trackA({ research: failedPassthrough }), 'B6(Black)+Blue case')).toBe(true);
  });

  it('escalates: researcher failed on Arabic short input', () => {
    expect(shouldEscalateLowInformation(trackA({ research: failedPassthrough }), 'B6 أسود أزرق')).toBe(true);
  });

  it('does not escalate: researcher never ran (clarity_verdict was clear)', () => {
    expect(shouldEscalateLowInformation(trackA({ research: null }), 'wireless headphones')).toBe(false);
  });

  it('does not escalate: researcher succeeded — enriched description is reliable', () => {
    expect(shouldEscalateLowInformation(trackA({ research: recognised }), 'phone case')).toBe(false);
  });

  it('does not escalate: researcher failed but web research succeeded', () => {
    expect(
      shouldEscalateLowInformation(
        trackA({ research: failedPassthrough, web_research: recognised }),
        'B6(Black)+Blue case',
      ),
    ).toBe(false);
  });

  it('does not escalate: researcher failed but description has enough tokens', () => {
    // 7 content tokens — retrieval has signal to work with even without
    // researcher enrichment.
    expect(
      shouldEscalateLowInformation(
        trackA({ research: failedPassthrough }),
        'unbranded portable bluetooth speaker stereo with carrying handle',
      ),
    ).toBe(false);
  });

  it('threshold is exactly 4 tokens — 4 tokens triggers, 5 does not', () => {
    expect(
      shouldEscalateLowInformation(trackA({ research: failedPassthrough }), 'one two three four'),
    ).toBe(true);
    expect(
      shouldEscalateLowInformation(trackA({ research: failedPassthrough }), 'one two three four five'),
    ).toBe(false);
  });

  it('punctuation does not inflate the token count', () => {
    // "B6(Black)+Blue case" looks like 4 separate words but contains
    // punctuation that gets stripped. After cleaning: B6, Black, Blue,
    // case → 4 content tokens.
    expect(
      shouldEscalateLowInformation(trackA({ research: failedPassthrough }), 'B6 ( Black ) + Blue case'),
    ).toBe(true);
  });
});
