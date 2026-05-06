/**
 * Unit tests for the simplified submission-description (Stage 2.5).
 *
 * Pins down: LLM-success path, ≤300 char cap, fallback on LLM failure,
 * fallback on empty LLM output, fallback on word-for-word collision with
 * the catalog leaf Arabic.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/llm/structured-call.js', () => ({
  structuredLlmCall: vi.fn(),
  loadPrompt: vi.fn().mockResolvedValue('mock-prompt'),
}));

import { generateSubmissionDescription, __test__ } from '../../src/modules/pipeline/submission-description/submission-description.js';
import { structuredLlmCall } from '../../src/inference/llm/structured-call.js';

const mockedCall = vi.mocked(structuredLlmCall);

const baseCtx = {
  cleanedDescription: 'wireless headphones',
  chosenCode: '851830000000',
  catalogLeafAr: 'سماعات لاسلكية',
  catalogLeafEn: 'wireless headphones',
  catalogPathAr: 'آلات وأجهزة كهربائية > سماعات > سماعات لاسلكية',
  catalogPathEn: 'Electrical machines > Headphones > Wireless headphones',
};

describe('generateSubmissionDescription', () => {
  beforeEach(() => {
    mockedCall.mockReset();
  });

  it('returns the cleaned LLM Arabic on success', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: 'سماعات بلوتوث لاسلكية للأذن' },
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });
    const r = await generateSubmissionDescription(baseCtx);
    expect(r.invoked).toBe('llm');
    expect(r.descriptionAr).toBe('سماعات بلوتوث لاسلكية للأذن');
  });

  it('caps output at 300 characters', async () => {
    const longAr = 'هاتف ذكي '.repeat(200);
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: longAr },
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });
    const r = await generateSubmissionDescription({
      ...baseCtx,
      cleanedDescription: 'phone',
      chosenCode: '851712000000',
    });
    expect(r.descriptionAr.length).toBeLessThanOrEqual(300);
  });

  it('rejects verbatim catalog leaf and falls back', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: 'سماعات لاسلكية' },  // exactly the catalog leaf
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });
    const r = await generateSubmissionDescription(baseCtx);
    expect(r.invoked).toBe('fallback_after_collision');
    // Fallback prefixes a token from the cleaned description to the leaf.
    expect(r.descriptionAr).toContain('سماعات لاسلكية');
    expect(r.descriptionAr).not.toBe('سماعات لاسلكية');
  });

  it('rejects verbatim catalog leaf even with whitespace differences', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: '  سماعات   لاسلكية  ' },  // padded whitespace
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });
    const r = await generateSubmissionDescription(baseCtx);
    expect(r.invoked).toBe('fallback_after_collision');
  });

  it('falls back deterministically on LLM failure', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'llm_failed',
      trace: { latency_ms: 10, model: 'mock-haiku', stage: 'submission_description', status: 'error' },
    });
    const r = await generateSubmissionDescription(baseCtx);
    expect(r.invoked).toBe('llm_failed');
    expect(r.descriptionAr).toContain('سماعات لاسلكية');  // catalog leaf
    expect(r.descriptionAr).toContain('wireless');         // first item token
  });

  it('falls back to path leaf segment when catalog leaf Arabic is null', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'llm_failed',
      trace: { latency_ms: 10, model: 'mock-haiku', stage: 'submission_description', status: 'error' },
    });
    const r = await generateSubmissionDescription({
      ...baseCtx,
      catalogLeafAr: null,
    });
    expect(r.invoked).toBe('llm_failed');
    // Last segment of path_ar = "سماعات لاسلكية"
    expect(r.descriptionAr).toContain('سماعات لاسلكية');
  });

  it('synthesises a placeholder when both catalog leaf and path are null', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'llm_failed',
      trace: { latency_ms: 10, model: 'mock-haiku', stage: 'submission_description', status: 'error' },
    });
    const r = await generateSubmissionDescription({
      ...baseCtx,
      catalogLeafAr: null,
      catalogPathAr: null,
    });
    expect(r.invoked).toBe('llm_failed');
    expect(r.descriptionAr).toContain('منتج');
  });

  it('falls back when LLM returns ok but description_ar is empty', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: '' },
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });
    const r = await generateSubmissionDescription(baseCtx);
    expect(r.invoked).toBe('fallback');
    expect(r.descriptionAr.length).toBeGreaterThan(0);
  });
});

describe('equalsLeaf (helper)', () => {
  it('matches after NFKC + whitespace normalisation', () => {
    expect(__test__.equalsLeaf('سماعات لاسلكية', 'سماعات لاسلكية')).toBe(true);
    expect(__test__.equalsLeaf('  سماعات   لاسلكية  ', 'سماعات لاسلكية')).toBe(true);
  });

  it('returns false when at least one word differs', () => {
    expect(__test__.equalsLeaf('سماعات بلوتوث لاسلكية', 'سماعات لاسلكية')).toBe(false);
  });

  it('returns false when leaf is null', () => {
    expect(__test__.equalsLeaf('any', null)).toBe(false);
  });
});
