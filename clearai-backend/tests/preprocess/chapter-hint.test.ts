/**
 * Tests for the chapter-hint preprocess module.
 *
 * The LLM round-trip is exercised end-to-end via route smoke tests.
 * Here we pin down the deterministic surface:
 *   • coerceChapters strips invalid entries (out-of-range, non-digit, dupes)
 *   • coerceConfidence clamps to [0, 1] and defaults to 0 on garbage
 *   • predictChapterHint short-circuits on empty input without calling Haiku
 *
 * The internal helpers are not exported, so we exercise them via
 * predictChapterHint's empty-input fast path + the documented public surface.
 */
import { describe, expect, it, vi } from 'vitest';

// Mock the LLM call so we never hit Anthropic from unit tests.
vi.mock('../../src/llm/structured-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/structured-call.js')>();
  return {
    ...actual,
    structuredLlmCall: vi.fn(),
  };
});

import { predictChapterHint } from '../../src/preprocess/chapter-hint.js';
import { structuredLlmCall } from '../../src/llm/structured-call.js';

const mockedCall = vi.mocked(structuredLlmCall);

describe('predictChapterHint', () => {
  it('short-circuits on empty input WITHOUT calling the LLM', async () => {
    mockedCall.mockReset();
    const r = await predictChapterHint('');
    expect(r.invoked).toBe('llm_failed');
    expect(r.likelyChapters).toEqual([]);
    expect(r.confidence).toBe(0);
    expect(mockedCall).not.toHaveBeenCalled();
  });

  it('short-circuits on whitespace-only input', async () => {
    mockedCall.mockReset();
    const r = await predictChapterHint('   ');
    expect(mockedCall).not.toHaveBeenCalled();
    expect(r.likelyChapters).toEqual([]);
  });

  it('returns LLM-emitted chapters when valid', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { likely_chapters: ['64'], confidence: 0.95, rationale: 'footwear' },
      rawText: '{...}',
      trace: { model: 'claude-haiku', latency_ms: 120, status: 'ok', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('high heels');
    expect(r.likelyChapters).toEqual(['64']);
    expect(r.confidence).toBeCloseTo(0.95);
    expect(r.rationale).toBe('footwear');
    expect(r.invoked).toBe('llm');
  });

  it('drops invalid chapter codes (non-digit, out-of-range, dupes)', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        likely_chapters: ['64', 'XX', '99', '00', '64', '85'],  // 99 + 00 invalid; 64 dup
        confidence: 0.9,
        rationale: 'mixed',
      },
      rawText: '{...}',
      trace: { model: 'claude-haiku', latency_ms: 120, status: 'ok', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('mixed');
    expect(r.likelyChapters).toEqual(['64', '85']);
  });

  it('caps at 3 chapters even when LLM returns more', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: {
        likely_chapters: ['64', '61', '62', '85', '90'],
        confidence: 0.7,
        rationale: 'wide',
      },
      rawText: '{...}',
      trace: { model: 'claude-haiku', latency_ms: 120, status: 'ok', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('mixed');
    expect(r.likelyChapters).toHaveLength(3);
    expect(r.likelyChapters).toEqual(['64', '61', '62']);
  });

  it('forces confidence to 0 when chapters is empty even if LLM said high', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { likely_chapters: [], confidence: 0.9, rationale: 'no signal' },
      rawText: '{...}',
      trace: { model: 'claude-haiku', latency_ms: 120, status: 'ok', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('parcel');
    expect(r.likelyChapters).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it('clamps confidence to [0, 1]', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { likely_chapters: ['64'], confidence: 1.7, rationale: 'over' },
      rawText: '{...}',
      trace: { model: 'claude-haiku', latency_ms: 120, status: 'ok', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('shoe');
    expect(r.confidence).toBe(1);
  });

  it('returns empty hint on llm_failed', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'llm_failed',
      error: 'timeout',
      trace: { model: 'claude-haiku', latency_ms: 6000, status: 'timeout', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('whatever');
    expect(r.invoked).toBe('llm_failed');
    expect(r.likelyChapters).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it('returns empty hint on llm_unparseable', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'llm_unparseable',
      rawText: 'not JSON at all',
      trace: { model: 'claude-haiku', latency_ms: 200, status: 'ok', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('whatever');
    expect(r.invoked).toBe('llm_unparseable');
    expect(r.likelyChapters).toEqual([]);
  });

  it('coerces non-numeric confidence to 0', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { likely_chapters: ['64'], confidence: 'high' as unknown as number, rationale: 'bad-shape' },
      rawText: '{...}',
      trace: { model: 'claude-haiku', latency_ms: 120, status: 'ok', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('shoe');
    expect(r.confidence).toBe(0);
  });

  it('bounds rationale to 200 chars defensively', async () => {
    mockedCall.mockReset();
    mockedCall.mockResolvedValueOnce({
      kind: 'ok',
      data: { likely_chapters: ['64'], confidence: 0.9, rationale: 'x'.repeat(500) },
      rawText: '{...}',
      trace: { model: 'claude-haiku', latency_ms: 120, status: 'ok', stage: 'chapter_hint' },
    });
    const r = await predictChapterHint('shoe');
    expect(r.rationale).toHaveLength(200);
  });
});
