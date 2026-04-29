/**
 * Foundry LLM client.
 *
 * ANTHROPIC_BASE_URL is the **complete Target URI** including /v1/messages
 * (see ADR-0006). We POST directly with fetch — bypassing the SDK's URL
 * concatenation — but use the Anthropic JSON wire format unchanged.
 */
import { env } from '../config/env.js';
import type { LlmStatus } from '../types/domain.js';
export type { LlmStatus } from '../types/domain.js';

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

/**
 * Optional tools forwarded verbatim to the Anthropic-compatible API.
 * Today only Anthropic's hosted Web Search tool is supported. Foundry's
 * passthrough exposes it on Sonnet 4.6+ via the same wire format as
 * anthropic.com — verified by probe.
 */
export type LlmTool = {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
};

export interface LlmCallParams {
  model?: string; // overrides env LLM_MODEL
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Optional tools to enable on this call. Anthropic streams
   * `server_tool_use` and `web_search_tool_result` blocks before the
   * final `text` block — we pass them through unchanged. Callers that
   * want the rich tool-use blocks can read `raw.content`; the typical
   * caller just reads the final `text` synthesised by the model.
   */
  tools?: LlmTool[];
  /**
   * Per-call timeout override (ms). Defaults to env LLM_TIMEOUT_MS.
   * Web-search calls legitimately need a longer ceiling (Anthropic's
   * hosted search adds 5-15s); short extraction calls (cleanup,
   * best-effort) want a tighter ceiling so we fail fast on stuck
   * connections rather than burn the full default.
   */
  timeoutMs?: number;
}

export async function callLlm(params: LlmCallParams): Promise<LlmCallResult> {
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
    // Anthropic's hosted Web Search tool: streamed as `server_tool_use` +
    // `web_search_tool_result` blocks. We pass them through and read only
    // the final `text` block; the model has already synthesised the search
    // results into its answer.
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
      return {
        status: 'error',
        text: null,
        raw: errText,
        error: `HTTP ${res.status}: ${errText.slice(0, 300)}`,
        latencyMs: Date.now() - t0,
        model,
      };
    }
    const json = (await res.json()) as AnthropicResponse;
    const text =
      json.content?.find((b) => b.type === 'text')?.text ??
      (json.content && json.content[0]?.text) ??
      null;
    return {
      status: 'ok',
      text,
      raw: json,
      latencyMs: Date.now() - t0,
      model,
    };
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: msg.includes('aborted') ? 'timeout' : 'error',
      text: null,
      raw: null,
      error: msg,
      latencyMs: Date.now() - t0,
      model,
    };
  }
}

/**
 * Call with simple retry on 429 / 5xx. Returns the last result either way; the
 * decision-resolution layer decides what to do with operational failures.
 */
export async function callLlmWithRetry(params: LlmCallParams, retries = 2): Promise<LlmCallResult> {
  let last: LlmCallResult | null = null;
  const delays = [250, 1000];
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await callLlm(params);
    if (last.status === 'ok') return last;
    // Retry only on transient operational errors
    const errStr = last.error ?? '';
    const isTransient =
      last.status === 'timeout' ||
      /HTTP (429|5\d\d)/.test(errStr) ||
      /network|fetch|ECONN|ETIMEDOUT/i.test(errStr);
    if (!isTransient || attempt === retries) return last;
    await new Promise((r) => setTimeout(r, delays[attempt] ?? 1000));
  }
  return last!;
}
