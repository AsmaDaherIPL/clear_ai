/**
 * Unit tests for the LLM circuit breaker.
 *
 * Covers:
 *   - classifyLlmOutcome maps statuses + HTTP codes to {ok, auth_class,
 *     transient, other}
 *   - recordLlmOutcome trips after TRIP_THRESHOLD consecutive auth_class
 *     failures
 *   - Breaker auto-resets on first ok call
 *   - Transient and other outcomes do NOT advance the auth counter
 *   - status() returns a faithful snapshot
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyLlmOutcome,
  recordLlmOutcome,
  isBreakerTripped,
  breakerStatus,
  __resetBreakerForTests,
} from '../../src/inference/llm/breaker.js';
import type { LlmCallResult } from '../../src/inference/llm/client.js';

function result(partial: Partial<LlmCallResult>): LlmCallResult {
  return {
    status: 'ok',
    text: null,
    raw: null,
    latencyMs: 12,
    model: 'mock-model',
    ...partial,
  } as LlmCallResult;
}

beforeEach(() => {
  __resetBreakerForTests();
});

describe('classifyLlmOutcome', () => {
  it('classifies status=ok as ok', () => {
    expect(classifyLlmOutcome(result({ status: 'ok' }))).toBe('ok');
  });

  it('classifies status=timeout as transient', () => {
    expect(classifyLlmOutcome(result({ status: 'timeout', error: 'aborted' }))).toBe('transient');
  });

  it('classifies HTTP 401 as auth_class', () => {
    expect(classifyLlmOutcome(result({ status: 'error', error: 'HTTP 401: unauthorized' }))).toBe(
      'auth_class',
    );
  });

  it('classifies HTTP 403 as auth_class (Foundry RBAC denial)', () => {
    expect(
      classifyLlmOutcome(
        result({ status: 'error', error: 'HTTP 403: ERR_BAD_REQUEST principal lacks data action' }),
      ),
    ).toBe('auth_class');
  });

  it('classifies HTTP 404 as auth_class (model deployment gone)', () => {
    expect(
      classifyLlmOutcome(result({ status: 'error', error: 'HTTP 404: deployment not found' })),
    ).toBe('auth_class');
  });

  it('classifies HTTP 429 as transient', () => {
    expect(
      classifyLlmOutcome(result({ status: 'error', error: 'HTTP 429: rate limited' })),
    ).toBe('transient');
  });

  it('classifies HTTP 500 / 502 / 503 as transient', () => {
    expect(classifyLlmOutcome(result({ status: 'error', error: 'HTTP 500' }))).toBe('transient');
    expect(classifyLlmOutcome(result({ status: 'error', error: 'HTTP 502' }))).toBe('transient');
    expect(classifyLlmOutcome(result({ status: 'error', error: 'HTTP 503' }))).toBe('transient');
  });

  it('classifies network/ECONN errors as transient', () => {
    expect(
      classifyLlmOutcome(result({ status: 'error', error: 'fetch failed: ECONNREFUSED' })),
    ).toBe('transient');
  });

  it('classifies non-HTTP, non-network errors as other (no breaker effect)', () => {
    expect(classifyLlmOutcome(result({ status: 'error', error: 'unexpected JSON shape' }))).toBe(
      'other',
    );
  });
});

describe('recordLlmOutcome — breaker state machine', () => {
  it('starts healthy', () => {
    expect(isBreakerTripped()).toBe(false);
    expect(breakerStatus().consecutive_auth_failures).toBe(0);
  });

  it('does not trip on a single auth-class failure', () => {
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    expect(isBreakerTripped()).toBe(false);
    expect(breakerStatus().consecutive_auth_failures).toBe(1);
  });

  it('does not trip on two consecutive auth-class failures (threshold = 3)', () => {
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 403' }));
    expect(isBreakerTripped()).toBe(false);
    expect(breakerStatus().consecutive_auth_failures).toBe(2);
  });

  it('trips on the third consecutive auth-class failure', () => {
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 403' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 404' }));
    expect(isBreakerTripped()).toBe(true);
    const s = breakerStatus();
    expect(s.tripped_at_ms).toBeTypeOf('number');
    expect(s.last_error).toMatch(/HTTP 404/);
  });

  it('auto-resets on the first ok call', () => {
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 403' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 404' }));
    expect(isBreakerTripped()).toBe(true);

    recordLlmOutcome(result({ status: 'ok' }));
    expect(isBreakerTripped()).toBe(false);
    expect(breakerStatus().consecutive_auth_failures).toBe(0);
    expect(breakerStatus().last_error).toBeNull();
  });

  it('a transient failure between auth failures does NOT reset the counter', () => {
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 503' })); // transient, no-op
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    // Three auth failures total → tripped.
    expect(isBreakerTripped()).toBe(true);
  });

  it('an ok call between auth failures DOES reset the counter (real recovery)', () => {
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'ok' })); // recovered
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    // Counter is at 1 after recovery + new failure — still healthy.
    expect(isBreakerTripped()).toBe(false);
    expect(breakerStatus().consecutive_auth_failures).toBe(1);
  });

  it('transient failures alone never trip the breaker (no matter how many)', () => {
    for (let i = 0; i < 10; i++) {
      recordLlmOutcome(result({ status: 'error', error: 'HTTP 503' }));
      recordLlmOutcome(result({ status: 'timeout', error: 'aborted' }));
    }
    expect(isBreakerTripped()).toBe(false);
    expect(breakerStatus().consecutive_auth_failures).toBe(0);
  });

  it('tripped_at_ms only set the first time threshold is crossed (not bumped on each subsequent failure)', () => {
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
    const firstTrip = breakerStatus().tripped_at_ms!;
    expect(firstTrip).toBeTypeOf('number');

    // Sleep a beat then add another failure; tripped_at_ms must NOT change.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        recordLlmOutcome(result({ status: 'error', error: 'HTTP 401' }));
        expect(breakerStatus().tripped_at_ms).toBe(firstTrip);
        resolve();
      }, 5);
    });
  });
});
