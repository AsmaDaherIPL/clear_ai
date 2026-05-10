/**
 * Process-local circuit breaker for the Foundry LLM.
 *
 * Distinguishes "transient" failures (5xx, timeout, rate limit) from
 * "auth-class" failures (401, 403, 404) that won't recover without human
 * intervention. Transient failures are absorbed by the existing retry +
 * graceful-degrade path in the pipeline (low-confidence escalation, HITL).
 * Auth-class failures trip the breaker after a small consecutive count, and
 * dispatch routes refuse to start new classifications until the breaker
 * resets.
 *
 * Why a breaker rather than failing on the first 401?
 *   A single 401 could be a one-off — a misrouted call, a key just rotated
 *   between requests, a stale connection. Three consecutive auth failures
 *   from independent calls is no longer plausibly transient: the env is
 *   broken and every classification will silently produce a `low`-confidence
 *   override-passthrough or escalate. That is data corruption with a
 *   clean-looking trace, which is worse than refusing service.
 *
 * Auto-reset on first successful LLM call. Per-process state — each
 * container revision starts clean.
 */
import type { LlmCallResult } from './client.js';

/**
 * Classification of an LLM call outcome for breaker purposes.
 *
 * ok           — the call succeeded; reset the breaker.
 * auth_class   — HTTP 401 / 403 / 404 (or a model-not-found body). Won't
 *                recover on its own; counts toward tripping the breaker.
 * transient    — HTTP 429 / 5xx, network errors, timeouts. Does NOT count
 *                toward the breaker. Existing retry + graceful-degrade
 *                handles these.
 * other        — non-HTTP error (e.g. JSON parse, schema violations
 *                surfaced from upstream). Conservative: don't trip on
 *                these — they may indicate caller bugs, not infra outage.
 */
export type LlmFailureClass = 'ok' | 'auth_class' | 'transient' | 'other';

const HTTP_RE = /HTTP (\d{3})/;

export function classifyLlmOutcome(result: LlmCallResult): LlmFailureClass {
  if (result.status === 'ok') return 'ok';
  if (result.status === 'timeout') return 'transient';
  // status === 'error'; introspect the error string for HTTP code.
  const m = result.error?.match(HTTP_RE);
  if (m) {
    const code = Number(m[1]);
    if (code === 401 || code === 403 || code === 404) return 'auth_class';
    if (code === 429 || (code >= 500 && code < 600)) return 'transient';
    return 'other';
  }
  // Network-class fetch errors look like ECONN..., fetch failed, etc.
  if (/network|fetch|ECONN|ETIMEDOUT|aborted/i.test(result.error ?? '')) return 'transient';
  return 'other';
}

interface BreakerState {
  consecutiveAuthFailures: number;
  trippedAt: number | null;
  lastErrorMessage: string | null;
}

const TRIP_THRESHOLD = 3;

const state: BreakerState = {
  consecutiveAuthFailures: 0,
  trippedAt: null,
  lastErrorMessage: null,
};

export interface BreakerStatus {
  tripped: boolean;
  /** Wall-clock ms since epoch when the breaker tripped. Null when healthy. */
  tripped_at_ms: number | null;
  /** Most recent auth-class error message (truncated). For diagnostics only. */
  last_error: string | null;
  consecutive_auth_failures: number;
}

export function breakerStatus(): BreakerStatus {
  return {
    tripped: state.trippedAt !== null,
    tripped_at_ms: state.trippedAt,
    last_error: state.lastErrorMessage,
    consecutive_auth_failures: state.consecutiveAuthFailures,
  };
}

export function isBreakerTripped(): boolean {
  return state.trippedAt !== null;
}

/**
 * Feed an LLM call outcome into the breaker. Call this exactly once per
 * `callLlm` (NOT once per retry attempt — `callLlmWithRetry` orchestrates
 * the retry loop and feeds only the final result).
 *
 * Side effects:
 *   ok          → reset breaker
 *   auth_class  → increment counter; trip when ≥ TRIP_THRESHOLD
 *   transient   → no-op (counter not advanced, breaker not reset either —
 *                 a 5xx storm shouldn't paper over an underlying auth issue)
 *   other       → no-op
 */
export function recordLlmOutcome(result: LlmCallResult): void {
  const cls = classifyLlmOutcome(result);
  if (cls === 'ok') {
    state.consecutiveAuthFailures = 0;
    state.trippedAt = null;
    state.lastErrorMessage = null;
    return;
  }
  if (cls === 'auth_class') {
    state.consecutiveAuthFailures += 1;
    state.lastErrorMessage = (result.error ?? 'unknown auth-class failure').slice(0, 300);
    if (state.consecutiveAuthFailures >= TRIP_THRESHOLD && state.trippedAt === null) {
      state.trippedAt = Date.now();
    }
  }
  // transient / other: no breaker state change.
}

/**
 * Test-only reset hook. Production code should rely on the auto-reset on
 * `ok`. Exported for unit-test isolation.
 */
export function __resetBreakerForTests(): void {
  state.consecutiveAuthFailures = 0;
  state.trippedAt = null;
  state.lastErrorMessage = null;
}
