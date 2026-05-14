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

  it('respects the 429 wait hint as a lower bound (Math.random=0 → exactly the hint)', () => {
    // Math.random() = 0 → extra = 0 → return exactly the clamped hint.
    // This is the lower bound; the hint is a hard floor, not a target.
    withFrozenRandom(0.0, () => {
      const err = 'HTTP 429: Please wait 23 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(23_000);
    });
  });

  it('clamps an over-ceiling wait hint to the 40s max', () => {
    withFrozenRandom(0.0, () => {
      // PR-A-5.3: ceiling raised 30s → 40s so additive jitter still
      // fits inside one 60s Foundry window.
      const err = 'HTTP 429: Please wait 90 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(40_000);
    });
  });

  it('clamps an absurdly-low wait hint to the 500ms floor', () => {
    withFrozenRandom(0.0, () => {
      const err = 'HTTP 429: Please wait 0 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(500);
    });
  });

  it('adds additive upward jitter [0, +50%] to a hinted wait (never below the hint)', () => {
    // Math.random() = 1.0 → extra = clamped × 0.5 → upper bound is +50%.
    // 10s hint × 1.5 = 15s.
    withFrozenRandom(1.0, () => {
      const err = 'HTTP 429: Please wait 10 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(15_000);
    });
    // Math.random() = 0.5 → extra = clamped × 0.25 → +25%.
    withFrozenRandom(0.5, () => {
      const err = 'HTTP 429: Please wait 10 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(12_500);
    });
    // Lower bound is the hint itself (additive upward only — we never
    // wait less than Foundry asked).
    withFrozenRandom(0.0, () => {
      const err = 'HTTP 429: Please wait 10 seconds before retrying.';
      expect(pickRetryDelayMs(err, 0)).toBe(10_000);
    });
  });

  it('jitter spread is wide enough to mitigate thundering herd', () => {
    // With 30 concurrent callers all reading "wait 17s", the additive
    // upward jitter [0, 50%] of 17s spreads them across an 8.5-second
    // window (17s to 25.5s). Pre-PR-A-5.3's ±10% gave a 3.4s spread,
    // which was too narrow to prevent re-saturating the next window.
    const err = 'HTTP 429: Please wait 17 seconds before retrying.';
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) samples.push(pickRetryDelayMs(err, 0));
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    // Min must be at least the hint itself (no callers wait less).
    expect(min).toBeGreaterThanOrEqual(17_000);
    // Max should approach the 50% upper bound. With 100 samples we'll
    // very rarely see Math.random() = 1.0, so check >= +20% as a
    // statistical floor.
    expect(max).toBeGreaterThanOrEqual(17_000 + 17_000 * 0.2);
    // And not exceed the +50% cap.
    expect(max).toBeLessThanOrEqual(17_000 + 17_000 * 0.5 + 1);
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
