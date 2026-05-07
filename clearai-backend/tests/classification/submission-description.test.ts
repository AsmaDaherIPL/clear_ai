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

// Mock the cache repository so unit tests don't need a live DB. Each test
// can override findCachedMock / upsertCachedMock to drive cache-hit /
// cache-miss / DB-failure scenarios.
const findCachedMock = vi.fn();
const upsertCachedMock = vi.fn();
const bumpHitMock = vi.fn();
vi.mock(
  '../../src/modules/pipeline/submission-description/submission-descriptions.repository.js',
  () => ({
    findCached: (...args: unknown[]) => findCachedMock(...args),
    upsertCached: (...args: unknown[]) => upsertCachedMock(...args),
    bumpHit: (...args: unknown[]) => bumpHitMock(...args),
    normalizeForCache: (s: string) =>
      s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
  }),
);

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
    findCachedMock.mockReset();
    upsertCachedMock.mockReset();
    bumpHitMock.mockReset();
    // Default: cache miss. Individual tests override for hit scenarios.
    findCachedMock.mockResolvedValue(null);
    upsertCachedMock.mockResolvedValue(undefined);
    bumpHitMock.mockResolvedValue(undefined);
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

describe('submission_descriptions cache', () => {
  beforeEach(() => {
    mockedCall.mockReset();
    findCachedMock.mockReset();
    upsertCachedMock.mockReset();
    bumpHitMock.mockReset();
    upsertCachedMock.mockResolvedValue(undefined);
    bumpHitMock.mockResolvedValue(undefined);
  });

  it('cache hit short-circuits the LLM call and returns invoked=cache', async () => {
    findCachedMock.mockResolvedValueOnce({
      id: 'cache-row-1',
      pathAr: baseCtx.catalogPathAr,
      cleanedDescriptionNorm: 'wireless headphones',
      descriptionAr: 'سماعات لاسلكية بلوتوث',
      source: 'llm',
      model: 'previous-model',
      hitCount: 5,
    });

    const r = await generateSubmissionDescription(baseCtx);

    expect(r.invoked).toBe('cache');
    expect(r.descriptionAr).toBe('سماعات لاسلكية بلوتوث');
    expect(r.model).toBe('previous-model');
    // No LLM call.
    expect(mockedCall).not.toHaveBeenCalled();
    // Hit-counter bumped (fire-and-forget, but we can assert it was called).
    expect(bumpHitMock).toHaveBeenCalledWith('cache-row-1');
    // No write on a hit.
    expect(upsertCachedMock).not.toHaveBeenCalled();
  });

  it('cache miss falls through to the LLM and writes the result back', async () => {
    findCachedMock.mockResolvedValueOnce(null);
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: 'سماعات لاسلكية بتقنية البلوتوث' },
      trace: { latency_ms: 80, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });

    const r = await generateSubmissionDescription(baseCtx);

    expect(r.invoked).toBe('llm');
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(upsertCachedMock).toHaveBeenCalledTimes(1);
    expect(upsertCachedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pathAr: baseCtx.catalogPathAr,
        cleanedDescriptionNorm: 'wireless headphones',
        cleanedDescriptionRaw: 'wireless headphones',
        descriptionAr: 'سماعات لاسلكية بتقنية البلوتوث',
        source: 'llm',
        model: 'mock-haiku',
      }),
    );
  });

  it('does NOT write the cache when LLM returns fallback (collision with leaf)', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: baseCtx.catalogLeafAr }, // verbatim leaf collision
      trace: { latency_ms: 40, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });

    const r = await generateSubmissionDescription(baseCtx);

    expect(r.invoked).toBe('fallback_after_collision');
    expect(upsertCachedMock).not.toHaveBeenCalled();
  });

  it('does NOT write the cache when LLM returns empty description', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: '' },
      trace: { latency_ms: 30, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });

    const r = await generateSubmissionDescription(baseCtx);

    expect(r.invoked).toBe('fallback');
    expect(upsertCachedMock).not.toHaveBeenCalled();
  });

  it('skips cache lookup entirely when catalogPathAr is null', async () => {
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { description_ar: 'سماعات لاسلكية' },
      trace: { latency_ms: 50, model: 'mock-haiku', stage: 'submission_description', status: 'ok' },
    });

    const r = await generateSubmissionDescription({ ...baseCtx, catalogPathAr: null });

    expect(r.invoked).toBe('fallback_after_collision'); // collides with catalogLeafAr
    // No cache I/O when there's no path_ar to key on.
    expect(findCachedMock).not.toHaveBeenCalled();
    expect(upsertCachedMock).not.toHaveBeenCalled();
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
