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
import { assertSonnetBudget, recordLlmCallCost } from './cost-breaker.js';
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
  /**
   * Per-call token usage from the Anthropic response (PR4 / TASKS R13).
   * Foundry-only deployment means no batch API → concurrency is the
   * only throughput lever. Per-call cost visibility is the prerequisite
   * for prompt-trim ROI measurement. Both fields are number when the
   * response carried usage; undefined when the field was missing or the
   * call failed before a response was received.
   */
  inputTokens?: number;
  outputTokens?: number;
}

interface AnthropicMessageBlock {
  type: string;
  text?: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  content?: AnthropicMessageBlock[];
  error?: { message?: string; type?: string };
  stop_reason?: string;
  usage?: AnthropicUsage;
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
  // 2026-05-19 (TASKS R5): breaker outcome is recorded ONCE per terminal
  // call in callLlm (after the inner 429 retry loop completes), NOT here
  // in per-attempt finalize. Previously 1 logical call → up to 3 breaker
  // writes (2 inner 429 retries + 1 terminal) which inflated the
  // transient-rate metric and fired the soft-warn spuriously.
  if (result.status !== 'ok') {
    const cls = classifyLlmOutcome(result);
    // Pino is wired by the fastify app; if unavailable (unit tests, scripts)
    // fall back to console so the message is never silently dropped.
    const msg = `[llm] call failed: status=${result.status} class=${cls} model=${result.model} latency=${result.latencyMs}ms err=${(result.error ?? '').slice(0, 300)}`;
    // eslint-disable-next-line no-console
    console.warn(msg);
  }

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

/**
 * Single attempt against Foundry. Issues the HTTP POST, feeds the
 * breaker, writes the per-attempt metric row. Does NOT retry.
 *
 * Extracted so callLlm can wrap it with a mandatory 429-only retry
 * loop without duplicating the request body, AbortController plumbing,
 * or finalize() side-effects. Stage call sites (identify, pick) call
 * callLlm — they get free 429 handling without changing their
 * "retries=0" intent for timeouts/5xx.
 */
async function callLlmOnce(params: LlmCallParams, attempt: number): Promise<LlmCallResult> {
  const { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } = env();
  const model = params.model ?? LLM_MODEL;
  // PR6 cost circuit breaker: refuse Sonnet calls when the rolling
  // window cap has been exceeded. Throw so the caller's promise
  // rejects (existing transport-error path picks it up as `error`
  // status with a clear message). Haiku is unbudgeted today.
  try {
    assertSonnetBudget(model);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return finalize(
      {
        status: 'error',
        text: null,
        raw: null,
        error: msg,
        latencyMs: 0,
        model,
      },
      params.stage,
      attempt,
    );
  }
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
        // ---- Auth headers — Foundry quirks documented below ----
        //
        // 2026-05-20: full-day outage on dev was traced to Foundry's
        // Anthropic gateway at swc-01 silently NOT serving requests that
        // arrive with only `api-key` / `x-api-key` headers (TCP+TLS
        // accepted, then no response body — abort window hit every time).
        // Discovered by accident: `Authorization: Bearer <same key>`
        // returns 200 in <3s for both Sonnet and Haiku on the SAME
        // deployment, with the SAME key. So the gateway accepts the key
        // — it just routes only the `Authorization: Bearer` form to the
        // upstream Anthropic backend; the other two get black-holed.
        //
        // Hypothesis: Foundry's "New Foundry" gateway changed the auth
        // contract on the /anthropic/v1/messages route. Earlier in the
        // year the route honoured `api-key` + `x-api-key`; today it
        // honours `Authorization: Bearer`. We send all three so the
        // code is tolerant if the contract changes again — Foundry
        // picks whichever header it recognises and ignores the others.
        //
        // The previous version of this comment block (and code) said
        // "send `api-key` + `x-api-key`, that's the fix". That diagnosis
        // is falsified — see this commit's message + the run on
        // 2026-05-20 where both headers produced 30-second hangs.
        Authorization: `Bearer ${ANTHROPIC_API_KEY}`,
        'api-key': ANTHROPIC_API_KEY,
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
    // Concatenate ALL text blocks. The Anthropic API can split a single
    // logical response into multiple `text` blocks when the model uses
    // tools (web_search), produces narration before its final answer,
    // or simply emits long output. Taking only the first text block
    // (the pre-PR-A-5.4 behavior) silently dropped the JSON in those
    // multi-block responses, surfacing as cause='parse' / reason='no_json'
    // on rows where the model actually produced valid output.
    //
    // For single-text-block responses (Haiku without tools, simple
    // prompts), join('\n') on a one-element array is identical to the
    // old behavior — no regression for the common case.
    const textBlocks =
      json.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '') ?? [];
    const text = textBlocks.length > 0 ? textBlocks.join('\n') : null;
    // PR4 / TASKS R13: surface per-call token usage so callers can
    // record cost into the trace and per-batch dashboards.
    const inputTokens =
      typeof json.usage?.input_tokens === 'number' ? json.usage.input_tokens : undefined;
    const outputTokens =
      typeof json.usage?.output_tokens === 'number' ? json.usage.output_tokens : undefined;
    return finalize(
      {
        status: 'ok',
        text,
        raw: json,
        latencyMs: Date.now() - t0,
        model,
        inputTokens,
        outputTokens,
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

/** Max 429 retries inside callLlm. Reduced 2 → 1 on 2026-05-17 after
 *  batch 019e348f-fce0 showed 7 picker 429 casualties at concurrency=16
 *  + cap=300k TPM. Each casualty burned ~50s of wall time waiting through
 *  Foundry's polite back-off hints. Under sustained-cap conditions the
 *  retries don't recover — they just delay the inevitable HITL escalation.
 *  One retry honors Foundry's stated wait window (typical hint: 8-23s)
 *  and fails fast if the cap is sticky. Sonnet cap raised to 600k TPM
 *  same day, so 429s should now be rare anyway; this caps the blast
 *  radius if they recur. */
const INNER_429_MAX_RETRIES = 1;

/** Total wall-clock budget for the inner 429 retry loop. Tightened
 *  90s → 45s on 2026-05-17 alongside the MAX_RETRIES cut. With one
 *  retry max + the 40s wait ceiling + one final attempt's timeout,
 *  45s is the natural upper bound. Prevents a single rate-limited
 *  call from pinning a concurrency slot for almost two minutes. */
const INNER_429_BUDGET_MS = 45_000;

/**
 * Call Foundry, automatically retrying 429s up to INNER_429_MAX_RETRIES
 * times respecting the "Please wait N seconds" hint.
 *
 * Why retry 429 *inside* callLlm rather than in callLlmWithRetry?
 *   Several stages (identify, pick) deliberately pass `retries=0` to
 *   callLlmWithRetry because their own designs don't want to compound
 *   tail latency on transport failures or want the circuit breaker to
 *   handle sustained outages. That choice is correct for timeout/5xx
 *   but **wrong for 429**: a 429 is not a failure, it's a provider
 *   signal saying "you'll succeed if you wait." Honoring that signal
 *   should be the default behavior of every Foundry call, not opt-in.
 *
 *   Pushing the 429 handling here gives every caller automatic
 *   recovery without changing the "retries" semantics they depend on.
 *
 * Non-429 errors (timeout, 5xx, network) pass through unchanged so
 * callers retain full control over those failure modes via
 * callLlmWithRetry.
 */
export async function callLlm(params: LlmCallParams): Promise<LlmCallResult> {
  const startedAt = Date.now();
  let last: LlmCallResult | null = null;
  for (let attempt = 1; attempt <= INNER_429_MAX_RETRIES + 1; attempt++) {
    last = await callLlmOnce(params, attempt);
    // Success or non-429 failure → return immediately.
    if (last.status === 'ok') break;
    const errStr = last.error ?? '';
    const is429 = /HTTP 429/.test(errStr);
    if (!is429) break;
    // Exhausted the 429 retry quota → surface the last 429 to the caller.
    if (attempt > INNER_429_MAX_RETRIES) break;
    // Compute wait time from the hint, with jitter to spread concurrent
    // callers across the next rate-limit window. If the next sleep would
    // exhaust the budget, give up and return the 429.
    const delay = pickRetryDelayMs(errStr, attempt - 1);
    if (Date.now() - startedAt + delay > INNER_429_BUDGET_MS) {
      break;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  // 2026-05-19 (TASKS R5): record the breaker outcome ONCE per logical
  // call, with the terminal result. callLlmOnce no longer feeds the
  // breaker per attempt. Edge-triggered transient warning moved here
  // too so it reads breakerStatus() once per terminal call.
  recordLlmOutcome(last!);
  // PR6: cost-breaker counter increments once per terminal call,
  // regardless of inner 429 retries (same logic as failure breaker).
  recordLlmCallCost(last!.model);
  const bs = breakerStatus();
  if (bs.transient_warning && !lastTransientWarning) {
    const pct = Math.round(bs.transient_rate * 100);
    // eslint-disable-next-line no-console
    console.warn(`[llm] transient warning: rate=${pct}% over last ${bs.window_size} calls`);
  }
  lastTransientWarning = bs.transient_warning;
  return last!;
}

/** Test-only reset hook for the edge-triggered transient-warn log flag. */
export function __resetTransientWarningStateForTests(): void {
  lastTransientWarning = false;
}

/** Hard ceiling on the wait time we honor from a Foundry 429 body. Foundry's
 *  rate-limit windows are 60s. We cap at 40s to leave room for the jitter
 *  upper bound (+50%) to still fit inside one window. */
const RATE_LIMIT_WAIT_CEILING_MS = 40_000;

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
 *                                     [FLOOR, CEILING], then ADD uniform
 *                                     [0, 50%] jitter on top so N concurrent
 *                                     callers spread across a window
 *                                     proportional to the hint instead of
 *                                     bunching at the exact "recovery" moment.
 *                                     With "wait 17s" + 50% spread, 30 callers
 *                                     hit Foundry across 8.5 seconds rather
 *                                     than 3.4 seconds (±10% pre-PR-A-5.3
 *                                     gave thundering herd).
 *   - 429 without hint              → ladder fallback with ±20% jitter.
 *   - 5xx / timeout / network       → same ladder fallback.
 *
 * Jitter strategy is "additive upward" for 429 specifically — we never
 * wait LESS than Foundry asked, because the provider's hint is a hard
 * lower bound for success. For non-429 we use ±20% symmetric jitter
 * since there's no provider-signaled minimum.
 *
 * Exported for unit-test isolation.
 */
export function pickRetryDelayMs(errString: string | undefined, attempt: number): number {
  const ladder = [500, 1500, 4000, 8000];
  const fallback = ladder[Math.min(attempt, ladder.length - 1)] ?? 8000;

  const hinted = parseRateLimitWaitMs(errString);
  if (hinted !== null) {
    const clamped = Math.max(RATE_LIMIT_WAIT_FLOOR_MS, Math.min(hinted, RATE_LIMIT_WAIT_CEILING_MS));
    // Additive upward jitter [0, 50%]. Never wait less than the hint.
    const extra = clamped * 0.5 * Math.random();
    return Math.floor(clamped + extra);
  }
  // Fallback ladder with ±20% symmetric jitter (no provider lower bound).
  const jitter = fallback * (Math.random() * 0.4 - 0.2);
  return Math.floor(fallback + jitter);
}

/** Default wall-clock budget for the retry loop. A single 60s rate-limit
 *  window plus a few-second margin — enough to ride out one Foundry window
 *  on 429, but bounded so a sustained outage doesn't hang the caller forever. */
const DEFAULT_RETRY_BUDGET_MS = 75_000;

/**
 * Call with retry on 5xx / timeout / network. Returns the last result.
 *
 * Layering note (PR-A-5.3):
 *   429s are handled by callLlm's INNER retry loop, not here. By the
 *   time a 429 bubbles up to callLlmWithRetry, callLlm has already
 *   spent INNER_429_MAX_RETRIES on it. Retrying 429 again at this
 *   layer would compound waits and starve the wall-clock budget for
 *   the timeouts/5xx we actually want to retry on. We treat 429 as a
 *   terminal failure here.
 *
 *   Stages that pass `retries=0` (identify, pick) still get automatic
 *   429 recovery via callLlm. Stages that pass `retries>0` (cleanup,
 *   submission, sanity, etc.) get 429 recovery AND additional retries
 *   for 5xx/timeout.
 *
 *   Total wall-clock is capped by `totalBudgetMs` (default 75s) so a
 *   degraded Foundry doesn't hold a single-shot route open indefinitely.
 *   When the budget would be exceeded by the next sleep, the loop exits
 *   with the last failure rather than waiting and timing out anyway.
 *
 * Reasons to NOT retry: 4xx (auth-class or bad request, OR 429 which
 * callLlm already retried). Fall through to the breaker / caller.
 */
export async function callLlmWithRetry(
  params: LlmCallParams,
  retries = 4,
  totalBudgetMs = DEFAULT_RETRY_BUDGET_MS,
): Promise<LlmCallResult> {
  let last: LlmCallResult | null = null;
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await callLlm(params);
    if (last.status === 'ok') return last;
    const errStr = last.error ?? '';
    // 429 was already retried inside callLlm; don't compound here.
    // 5xx / timeout / network → eligible for this layer's retry.
    const isRetriable =
      last.status === 'timeout' ||
      /HTTP 5\d\d/.test(errStr) ||
      /network|fetch|ECONN|ETIMEDOUT/i.test(errStr);
    if (!isRetriable || attempt === retries) return last;
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
