/**
 * Cost circuit breaker (PR6 / plan §1.6.1, 2026-05-19).
 *
 * Tracks Sonnet + Haiku call counts per "session" (rolling window of
 * 200 rows × ~8 calls/row = 1600 max Sonnet calls) and trips when a
 * configurable hard cap is exceeded. The trip surfaces as an exception
 * the call site decides whether to honor.
 *
 * Process-local for now (no Redis). For a single replica this is
 * sufficient; for multi-replica we'd promote to a shared store. The
 * cap is intentionally generous — it's a kill-switch for runaway
 * cost, not a rate limiter.
 *
 * Counters reset every CIRCUIT_WINDOW_MS (default 1h). Reset is
 * idempotent on read — no background timer.
 */

interface CostState {
  sonnetCalls: number;
  haikuCalls: number;
  windowStartMs: number;
  trippedSonnetAtMs: number | null;
}

const state: CostState = {
  sonnetCalls: 0,
  haikuCalls: 0,
  windowStartMs: Date.now(),
  trippedSonnetAtMs: null,
};

const CIRCUIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function maxSonnetCallsPerWindow(): number {
  const fromEnv = parseInt(process.env.MAX_SONNET_CALLS_PER_BATCH ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 1600;
}

function rollWindowIfNeeded(now: number): void {
  if (now - state.windowStartMs >= CIRCUIT_WINDOW_MS) {
    state.sonnetCalls = 0;
    state.haikuCalls = 0;
    state.windowStartMs = now;
    state.trippedSonnetAtMs = null;
  }
}

/**
 * Classify by model name. Cheap string check — Foundry deployment
 * names contain "sonnet" / "haiku" by convention.
 */
function bucketForModel(model: string): 'sonnet' | 'haiku' | 'other' {
  const lower = model.toLowerCase();
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return 'other';
}

/** Record a completed LLM call (call after recordLlmOutcome). */
export function recordLlmCallCost(model: string): void {
  const now = Date.now();
  rollWindowIfNeeded(now);
  const bucket = bucketForModel(model);
  if (bucket === 'sonnet') {
    state.sonnetCalls += 1;
    if (
      state.sonnetCalls > maxSonnetCallsPerWindow() &&
      state.trippedSonnetAtMs === null
    ) {
      state.trippedSonnetAtMs = now;
      // eslint-disable-next-line no-console
      console.error(
        `[cost-breaker] Sonnet call cap exceeded: ${state.sonnetCalls} calls in current window (cap=${maxSonnetCallsPerWindow()}). Subsequent Sonnet calls will be rejected until window rolls over.`,
      );
    }
  } else if (bucket === 'haiku') {
    state.haikuCalls += 1;
  }
}

/**
 * Throw if the Sonnet breaker is tripped. Call this BEFORE issuing a
 * Sonnet request from a stage that wants to participate in cost
 * limiting. Currently called from the LLM client just before fetch.
 */
export function assertSonnetBudget(model: string): void {
  rollWindowIfNeeded(Date.now());
  if (bucketForModel(model) === 'sonnet' && state.trippedSonnetAtMs !== null) {
    throw new Error(
      `Sonnet cost circuit breaker tripped: ${state.sonnetCalls} calls in current window exceeded cap=${maxSonnetCallsPerWindow()}. Window rolls over at ${new Date(state.windowStartMs + CIRCUIT_WINDOW_MS).toISOString()}.`,
    );
  }
}

/** Diagnostic snapshot — used by health checks / dashboards. */
export function costBreakerStatus(): {
  sonnet_calls: number;
  haiku_calls: number;
  sonnet_cap: number;
  tripped: boolean;
  window_start: string;
} {
  rollWindowIfNeeded(Date.now());
  return {
    sonnet_calls: state.sonnetCalls,
    haiku_calls: state.haikuCalls,
    sonnet_cap: maxSonnetCallsPerWindow(),
    tripped: state.trippedSonnetAtMs !== null,
    window_start: new Date(state.windowStartMs).toISOString(),
  };
}

/** Test-only reset. */
export function __resetCostBreakerForTests(): void {
  state.sonnetCalls = 0;
  state.haikuCalls = 0;
  state.windowStartMs = Date.now();
  state.trippedSonnetAtMs = null;
}
