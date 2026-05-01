/**
 * Foundry LLM client. Posts directly to ANTHROPIC_BASE_URL (complete Target
 * URI per ADR-0006) using the Anthropic JSON wire format.
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

/** Optional tool forwarded to the Anthropic-compatible API (hosted Web Search). */
export type LlmTool = {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
};

export interface LlmCallParams {
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

/** Call with simple retry on 429 / 5xx. Returns the last result either way. */
export async function callLlmWithRetry(params: LlmCallParams, retries = 2): Promise<LlmCallResult> {
  let last: LlmCallResult | null = null;
  const delays = [250, 1000];
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await callLlm(params);
    if (last.status === 'ok') return last;
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
