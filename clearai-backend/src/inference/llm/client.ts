/**
 * Foundry LLM client. Posts directly to ANTHROPIC_BASE_URL (complete Target
 * URI per ADR-0006) using the Anthropic JSON wire format.
 *
 * Every call result feeds the LLM circuit breaker (see ./breaker.ts) so
 * sustained auth-class failures (401/403/404) trip a process-local breaker
 * and dispatch routes refuse to start new classifications until the env
 * is repaired. Transient failures (429/5xx, timeout) do NOT trip the
 * breaker — they are absorbed by retry + graceful degradation upstream.
 */
import { env } from '../../config/env.js';
import { recordLlmOutcome, classifyLlmOutcome, breakerStatus } from './breaker.js';
import { writeLlmCallMetric } from './metrics.js';
import type { LlmStage } from './policy.js';
import type { LlmStatus } from '../../modules/pipeline/shared/domain.types.js';
export type { LlmStatus } from '../../modules/pipeline/shared/domain.types.js';

export interface LlmCallResult {
  status: LlmStatus;
  text: string | null;
  raw: unknown;
  error?: string;
  latencyMs: number;
  model: string;
}

interface AnthropicMessageBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicMessageBlock[];
  error?: { message?: string; type?: string };
  stop_reason?: string;
}

/** Optional tool forwarded to the Anthropic-compatible API (hosted Web Search). */
export type LlmTool = {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
};

export interface LlmCallParams {
  /**
   * Stage label for metrics and tracing. When omitted, the call is not
   * recorded in `llm_call_metrics` (legacy / ad-hoc callers).
   */
  stage?: LlmStage;
  /** Overrides env LLM_MODEL. */
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  tools?: LlmTool[];
  /** Per-call timeout override (ms). Defaults to env LLM_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Module-local flag for the transient-warn edge transition. We log on
 * false -> true so a sustained warning state doesn't spam the log on every
 * call. Reset back to false when the rolling window recovers below the
 * threshold.
 */
let lastTransientWarning = false;

const HTTP_STATUS_RE = /HTTP (\d{3})/;

function extractHttpStatus(error: string | undefined): number | null {
  if (!error) return null;
  const m = error.match(HTTP_STATUS_RE);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Single exit point for `callLlm`. Feeds the breaker and emits a WARN log
 * on every non-ok result so failures are visible in container logs without
 * having to read full pipeline traces. The result object is returned
 * unchanged so callers can keep their existing branching.
 *
 * When `stage` is provided, also fires a best-effort insert into
 * `llm_call_metrics`. The insert is fire-and-forget — a DB outage here
 * MUST NOT block the LLM call or surface to the caller.
 */
function finalize(
  result: LlmCallResult,
  stage: LlmStage | undefined,
  attempt: number,
): LlmCallResult {
  recordLlmOutcome(result);
  if (result.status !== 'ok') {
    const cls = classifyLlmOutcome(result);
    // Pino is wired by the fastify app; if unavailable (unit tests, scripts)
    // fall back to console so the message is never silently dropped.
    const msg = `[llm] call failed: status=${result.status} class=${cls} model=${result.model} latency=${result.latencyMs}ms err=${(result.error ?? '').slice(0, 300)}`;
    // eslint-disable-next-line no-console
    console.warn(msg);
  }
  // Edge-triggered transient-rate warning. Only log on the false -> true
  // transition so a sustained slow Foundry doesn't fill the log.
  const bs = breakerStatus();
  if (bs.transient_warning && !lastTransientWarning) {
    const pct = Math.round(bs.transient_rate * 100);
    // eslint-disable-next-line no-console
    console.warn(`[llm] transient warning: rate=${pct}% over last ${bs.window_size} calls`);
  }
  lastTransientWarning = bs.transient_warning;

  if (stage) {
    void writeLlmCallMetric({
      stage,
      model: result.model,
      attempt,
      outcomeClass: classifyLlmOutcome(result),
      latencyMs: result.latencyMs,
      httpStatus: extractHttpStatus(result.error),
      errorClass: result.status === 'ok' ? null : result.status,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[llm_call_metrics] insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  return result;
}

export async function callLlm(params: LlmCallParams, attempt = 1): Promise<LlmCallResult> {
  const { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } = env();
  const model = params.model ?? LLM_MODEL;
  const t0 = Date.now();

  const body: Record<string, unknown> = {
    model,
    max_tokens: params.maxTokens ?? 1024,
    temperature: params.temperature ?? 0,
    system: params.system,
    messages: [{ role: 'user', content: params.user }],
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), params.timeoutMs ?? LLM_TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_BASE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return finalize(
        {
          status: 'error',
          text: null,
          raw: errText,
          error: `HTTP ${res.status}: ${errText.slice(0, 300)}`,
          latencyMs: Date.now() - t0,
          model,
        },
        params.stage,
        attempt,
      );
    }
    const json = (await res.json()) as AnthropicResponse;
    const text =
      json.content?.find((b) => b.type === 'text')?.text ??
      (json.content && json.content[0]?.text) ??
      null;
    return finalize(
      {
        status: 'ok',
        text,
        raw: json,
        latencyMs: Date.now() - t0,
        model,
      },
      params.stage,
      attempt,
    );
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    return finalize(
      {
        status: msg.includes('aborted') ? 'timeout' : 'error',
        text: null,
        raw: null,
        error: msg,
        latencyMs: Date.now() - t0,
        model,
      },
      params.stage,
      attempt,
    );
  }
}

/** Test-only reset hook for the edge-triggered transient-warn log flag. */
export function __resetTransientWarningStateForTests(): void {
  lastTransientWarning = false;
}

/** Hard ceiling on the wait time we honor from a Foundry 429 body. Foundry's
 *  rate-limit windows are 60s, so any value beyond ~30s is either malformed
 *  or means we're better off escalating than blocking the request. */
const RATE_LIMIT_WAIT_CEILING_MS = 30_000;

/** Floor on a parsed 429 wait so we don't busy-spin on a malformed "wait 0". */
const RATE_LIMIT_WAIT_FLOOR_MS = 500;

/**
 * Parse the "Please wait N seconds" hint Foundry returns in its 429 body.
 * Foundry's literal format (observed 2026-05-14):
 *
 *   HTTP 429: {"error":{"code":"RateLimitReached","message":
 *     "Rate limit of 300000 per 60s exceeded for ... Please wait 23 seconds
 *      before retrying."}}
 *
 * Returns the wait duration in ms when present, null otherwise. Caller
 * applies floor/ceiling clamping and jitter.
 */
export function parseRateLimitWaitMs(errString: string | undefined): number | null {
  if (!errString) return null;
  const m = errString.match(/wait\s+(\d+)\s+seconds?/i);
  if (!m || !m[1]) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

/**
 * Pick the wait-before-retry duration for a transient failure.
 *
 *   - 429 with parseable wait hint  → respect the hint, clamped to
 *                                     [FLOOR, CEILING], plus ±10% jitter so
 *                                     N concurrent callers don't wake up
 *                                     and all hit the next rate-limit
 *                                     window at the same instant.
 *   - 429 without hint              → use the same backoff ladder as 5xx.
 *   - 5xx / timeout / network       → exponential backoff with jitter from
 *                                     a fixed ladder.
 *
 * Exported for unit-test isolation.
 */
export function pickRetryDelayMs(errString: string | undefined, attempt: number): number {
  const ladder = [500, 1500, 4000, 8000];
  const fallback = ladder[Math.min(attempt, ladder.length - 1)] ?? 8000;

  const hinted = parseRateLimitWaitMs(errString);
  if (hinted !== null) {
    const clamped = Math.max(RATE_LIMIT_WAIT_FLOOR_MS, Math.min(hinted, RATE_LIMIT_WAIT_CEILING_MS));
    const jitter = clamped * (Math.random() * 0.2 - 0.1); // ±10%
    return Math.floor(clamped + jitter);
  }
  // Fallback ladder with ±20% jitter.
  const jitter = fallback * (Math.random() * 0.4 - 0.2);
  return Math.floor(fallback + jitter);
}

/** Default wall-clock budget for the retry loop. A single 60s rate-limit
 *  window plus a few-second margin — enough to ride out one Foundry window
 *  on 429, but bounded so a sustained outage doesn't hang the caller forever. */
const DEFAULT_RETRY_BUDGET_MS = 75_000;

/**
 * Call with retry on 429 / 5xx / timeout. Returns the last result either way.
 *
 * 429 handling (PR-A-5.2):
 *   Foundry returns a literal "Please wait N seconds" in the error body
 *   when a rate-limit window is exceeded. parseRateLimitWaitMs reads that
 *   hint and pickRetryDelayMs uses it to pace the next attempt. The
 *   default retry count was bumped from 2 → 4 so a sustained 60-second
 *   rate-limit window can be ridden out (1+4 attempts × up to 30s wait
 *   each ≈ 75s, bounded by totalBudgetMs).
 *
 *   Total wall-clock is capped by `totalBudgetMs` (default 75s) so a
 *   degraded Foundry doesn't hold a single-shot route open indefinitely.
 *   When the budget would be exceeded by the next sleep, the loop exits
 *   with the last failure rather than waiting and timing out anyway.
 *
 * Reasons to NOT retry: 4xx other than 429 (auth-class or bad request),
 * fall through to the breaker / caller without further attempts.
 */
export async function callLlmWithRetry(
  params: LlmCallParams,
  retries = 4,
  totalBudgetMs = DEFAULT_RETRY_BUDGET_MS,
): Promise<LlmCallResult> {
  let last: LlmCallResult | null = null;
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await callLlm(params, attempt + 1);
    if (last.status === 'ok') return last;
    const errStr = last.error ?? '';
    const isTransient =
      last.status === 'timeout' ||
      /HTTP (429|5\d\d)/.test(errStr) ||
      /network|fetch|ECONN|ETIMEDOUT/i.test(errStr);
    if (!isTransient || attempt === retries) return last;
    const delay = pickRetryDelayMs(errStr, attempt);
    if (Date.now() - startedAt + delay > totalBudgetMs) {
      // Sleeping would exhaust the budget; return the last failure rather
      // than wait and then time-out anyway. Caller sees a transient error
      // and can escalate via the policy's onExhausted handler.
      return last;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  return last!;
}
