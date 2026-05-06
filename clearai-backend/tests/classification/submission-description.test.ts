/**
 * Unit tests for the simplified submission-description (Stage 2.5).
 *
 * Pins down: LLM-success path returns the cleaned LLM Arabic, ≤300 char cap,
 * fallback path on LLM failure uses the catalog when present, and the
 * synthetic 'منتج: ...' fallback when catalog is null.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inference/llm/structured-call.js', () => ({
  structuredLlmCall: vi.fn(),
  loadPrompt: vi.fn().mockResolvedValue('mock-prompt'),
}));

import { generateSubmissionDescription } from '../../src/modules/pipeline/submission-description/submission-description.js';
import { structuredLlmCall } from '../../src/inference/llm/structured-call.js';

const mockedCall = vi.mocked(structuredLlmCall);

describe('generateSubmissionDescription', () => {
  beforeEach(() => {
    mockedCall.mockReset();
  });

  it('returns the cleaned LLM Arabic on success', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: 'سماعات بلوتوث لاسلكية' },
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });
    const r = await generateSubmissionDescription({
      cleanedDescription: 'wireless headphones',
      chosenCode: '851830000000',
      catalogDescriptionAr: 'سماعات',
    });
    expect(r.invoked).toBe('llm');
    expect(r.descriptionAr).toBe('سماعات بلوتوث لاسلكية');
  });

  it('caps output at 300 characters', async () => {
    const longAr = 'هاتف ذكي '.repeat(200);
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: longAr },
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });
    const r = await generateSubmissionDescription({
      cleanedDescription: 'phone',
      chosenCode: '851712000000',
      catalogDescriptionAr: null,
    });
    expect(r.descriptionAr.length).toBeLessThanOrEqual(300);
  });

  it('falls back to the catalog Arabic on LLM failure', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'llm_failed',
      trace: { latency_ms: 10, model: 'mock-haiku', stage: 'submission_description', status: 'error' },
    });
    const r = await generateSubmissionDescription({
      cleanedDescription: 'cotton shirt',
      chosenCode: '610910000000',
      catalogDescriptionAr: 'قميص قطني',
    });
    expect(r.invoked).toBe('llm_failed');
    expect(r.descriptionAr).toBe('قميص قطني');
  });

  it('uses the synthetic منتج: ... fallback when catalog AR is null and LLM fails', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'llm_failed',
      trace: { latency_ms: 10, model: 'mock-haiku', stage: 'submission_description', status: 'error' },
    });
    const r = await generateSubmissionDescription({
      cleanedDescription: 'unique gizmo',
      chosenCode: '999999999999',
      catalogDescriptionAr: null,
    });
    expect(r.invoked).toBe('llm_failed');
    expect(r.descriptionAr).toContain('منتج');
    expect(r.descriptionAr).toContain('unique gizmo');
  });

  it('falls back when LLM returns ok but description_ar is empty', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: '' },
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });
    const r = await generateSubmissionDescription({
      cleanedDescription: 'item',
      chosenCode: '851712000000',
      catalogDescriptionAr: 'هاتف',
    });
    expect(r.invoked).toBe('fallback');
    expect(r.descriptionAr).toBe('هاتف');
  });
});
