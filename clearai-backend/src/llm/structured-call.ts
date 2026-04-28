/**
 * Canonical "load prompt → call model → parse JSON → validate" helper.
 * Replaces six near-identical reimplementations across cleanup / picker /
 * branch-rank / best-effort / submission-desc / researcher.
 *
 * Returns a tagged union so callers can branch on outcome:
 *   ok | llm_failed (network/timeout) | llm_unparseable (no JSON) |
 *   schema_invalid (Zod rejected the shape).
 *
 * Forwards optional `tools` to the LLM client (Phase F web search).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { callLlmWithRetry, type LlmTool } from './client.js';
import { extractJson } from './parse-json.js';

const PROMPT_DIR = join(process.cwd(), 'prompts');

// Prompt cache. Stores promises (not strings) so concurrent first-reads
// collapse to one fs read. Failed reads are evicted so retry gets a fresh attempt.
const promptCache = new Map<string, Promise<string>>();

/** Load a prompt file from `prompts/<filename>`, cached per-process. */
export async function loadPrompt(filename: string): Promise<string> {
  const existing = promptCache.get(filename);
  if (existing) return existing;
  const promise = readFile(join(PROMPT_DIR, filename), 'utf8');
  promptCache.set(filename, promise);
  try {
    return await promise;
  } catch (err) {
    promptCache.delete(filename);
    throw err;
  }
}

/** Per-call trace row aggregated into the response's modelCalls block. */
export interface ModelCallTrace {
  model: string;
  latency_ms: number;
  status: 'ok' | 'error' | 'timeout';
  /** Stage label, e.g. 'cleanup', 'picker', 'branch_rank'. */
  stage: string;
}

export type StructuredLlmOutcome<T> =
  | { kind: 'ok'; data: T; trace: ModelCallTrace; rawText: string }
  | { kind: 'llm_failed'; error: string; trace: ModelCallTrace }
  | { kind: 'llm_unparseable'; rawText: string; trace: ModelCallTrace }
  | { kind: 'schema_invalid'; rawText: string; trace: ModelCallTrace };

export interface StructuredLlmCallParams<TSchema extends z.ZodTypeAny> {
  /** Prompt filename relative to `prompts/`. */
  promptFile: string;
  user: string;
  /** Zod schema; validation failure returns `schema_invalid`. */
  schema: TSchema;
  /** Stage label for tracing (e.g. 'cleanup', 'branch_rank'). */
  stage: string;
  /** Defaults to env LLM_MODEL. */
  model?: string;
  /** Default 1024. */
  maxTokens?: number;
  /** Default 0 (deterministic). */
  temperature?: number;
  /** Forwarded to the LLM client (e.g. Anthropic hosted web_search). */
  tools?: LlmTool[];
  /** Transient-failure retries. Default 2. Schema failures are NOT retried. */
  retries?: number;
}

export async function structuredLlmCall<TSchema extends z.ZodTypeAny>(
  params: StructuredLlmCallParams<TSchema>,
): Promise<StructuredLlmOutcome<z.infer<TSchema>>> {
  const system = await loadPrompt(params.promptFile);

  const llm = await callLlmWithRetry(
    {
      system,
      user: params.user,
      ...(params.model ? { model: params.model } : {}),
      maxTokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0,
      ...(params.tools ? { tools: params.tools } : {}),
    },
    params.retries ?? 2,
  );

  const trace: ModelCallTrace = {
    model: llm.model,
    latency_ms: llm.latencyMs,
    status: llm.status,
    stage: params.stage,
  };

  if (llm.status !== 'ok' || !llm.text) {
    return {
      kind: 'llm_failed',
      error: llm.error ?? `provider returned ${llm.status} with no text`,
      trace,
    };
  }

  const extract = extractJson(llm.text, params.schema);
  if (!extract.ok) {
    return {
      kind: extract.reason === 'schema_invalid' ? 'schema_invalid' : 'llm_unparseable',
      rawText: llm.text,
      trace,
    };
  }

  return {
    kind: 'ok',
    data: extract.data,
    trace,
    rawText: llm.text,
  };
}
