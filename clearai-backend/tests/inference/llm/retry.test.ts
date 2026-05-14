/**
 * PR-A-5.2 — Foundry 429 Retry-After handling.
 *
 * Foundry returns rate-limit errors as HTTP 429 with a literal
 * "Please wait N seconds" hint in the body. The retry layer parses
 * that hint and uses it instead of the default exponential ladder so
 * we don't burn retries against a known-busy rate-limit window.
 *
 * These tests exercise the pure helpers only (parseRateLimitWaitMs,
 * pickRetryDelayMs). The fetch-level retry loop in callLlmWithRetry
 * is covered by integration tests under tests/anchored that mock the
 * LLM client at the module boundary.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseRateLimitWaitMs, pickRetryDelayMs } from '../../../src/inference/llm/client.js';

describe('parseRateLimitWaitMs', () => {
  it('extracts the wait hint from Foundry rate-limit body', () => {
    const err =
      'HTTP 429: {"error":{"code":"RateLimitReached","message":"Rate limit of 300000 per 60s exceeded for UserByModelByMinuteUncachedInputTokens. Please wait 23 seconds before retrying."}}';
    expect(parseRateLimitWaitMs(err)).toBe(23_000);
  });

  it('handles singular "1 second" form', () => {
    const err = 'HTTP 429: Please wait 1 second before retrying.';
    expect(parseRateLimitWaitMs(err)).toBe(1_000);
  });

  it('is case-insensitive on the literal keyword', () => {
    const err = 'HTTP 429: PLEASE WAIT 5 SECONDS before retrying.';
    expect(parseRateLimitWaitMs(err)).toBe(5_000);
  });

  it('returns null when no wait hint is present', () => {
    expect(parseRateLimitWaitMs('HTTP 429: rate limited but no hint')).toBeNull();
    expect(parseRateLimitWaitMs('HTTP 500: internal server error')).toBeNull();
    expect(parseRateLimitWaitMs('network timeout')).toBeNull();
  });

  it('returns null for undefined / empty input', () => {
    expect(parseRateLimitWaitMs(undefined)).toBeNull();
    expect(parseRateLimitWaitMs('')).toBeNull();
  });

  it('returns null for malformed numbers', () => {
    expect(parseRateLimitWaitMs('Please wait abc seconds')).toBeNull();
    // A negative wait makes no sense as a backoff hint.
    expect(parseRateLimitWaitMs('Please wait -5 seconds')).toBeNull();
  });
});

describe('pickRetryDelayMs', () => {
  // Stabilise jitter so we can assert on numeric ranges.
  function withFrozenRandom(value: number, fn: () => void): void {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(value);
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
  }

  it('respects the 429 wait hint, clamped to FLOOR/CEILING', () => {
    withFrozenRandom(0.5, () => {
      // 0.5 → jitter = 0 (centered)
      const err = 'HTTP 429: Please wait 23 seconds before retrying.';
      const delay = pickRetryDelayMs(err, 0);
      // 23000 ms exactly under the 30s ceiling.
      expect(delay).toBe(23_000);
    });
  });

  it('clamps an over-ceiling wait hint to the 30s max', () => {
    withFrozenRandom(0.5, () => {
      const err = 'HTTP 429: Please wait 90 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(30_000);
    });
  });

  it('clamps an absurdly-low wait hint to the 500ms floor', () => {
    withFrozenRandom(0.5, () => {
      const err = 'HTTP 429: Please wait 0 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(500);
    });
  });

  it('adds bounded jitter (±10%) to a hinted wait', () => {
    // Math.random() = 1.0 → jitter coefficient = +0.1 (10% above)
    withFrozenRandom(1.0, () => {
      const err = 'HTTP 429: Please wait 10 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(11_000);
    });
    // Math.random() = 0.0 → jitter coefficient = -0.1 (10% below)
    withFrozenRandom(0.0, () => {
      const err = 'HTTP 429: Please wait 10 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(9_000);
    });
  });

  it('falls back to ladder when no 429 hint present (5xx / timeout)', () => {
    withFrozenRandom(0.5, () => {
      // 0.5 → jitter coefficient = 0 (centered) → exact ladder value
      expect(pickRetryDelayMs('HTTP 500: gateway error', 0)).toBe(500);
      expect(pickRetryDelayMs('HTTP 500: gateway error', 1)).toBe(1_500);
      expect(pickRetryDelayMs('HTTP 500: gateway error', 2)).toBe(4_000);
      expect(pickRetryDelayMs('HTTP 500: gateway error', 3)).toBe(8_000);
      // Past the ladder, clamps to the last value.
      expect(pickRetryDelayMs('HTTP 500: gateway error', 9)).toBe(8_000);
    });
  });

  it('falls back to ladder when 429 lacks the wait hint', () => {
    withFrozenRandom(0.5, () => {
      // Plain 429 without "Please wait N seconds" — use the ladder.
      expect(pickRetryDelayMs('HTTP 429: rate limited', 0)).toBe(500);
      expect(pickRetryDelayMs('HTTP 429: rate limited', 1)).toBe(1_500);
    });
  });
});
