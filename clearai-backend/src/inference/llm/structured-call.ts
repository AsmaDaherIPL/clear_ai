/**
 * Canonical "load prompt → call model → parse JSON → validate" helper.
 * Returns a tagged union: ok | llm_failed | llm_unparseable | schema_invalid.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { callLlmWithRetry, type LlmStatus, type LlmTool } from './client.js';
import { extractJson } from './parse-json.js';

const PROMPT_DIR = join(process.cwd(), 'prompts');

// Cache stores promises so concurrent first-reads collapse to one fs read.
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
  /** Wall-clock latency across every parse-retry attempt. */
  latency_ms: number;
  status: LlmStatus;
  /** Stage label, e.g. 'cleanup', 'picker', 'branch_rank'. */
  stage: string;
  /** Total parse attempts (>=1). */
  attempts: number;
  /**
   * Reason recorded for each attempt that triggered a parse retry. Empty
   * when the first attempt parsed cleanly.
   */
  retried_reasons?: string[];
}

export type StructuredLlmOutcome<T> =
  | { kind: 'ok'; data: T; trace: ModelCallTrace; rawText: string }
  | { kind: 'llm_failed'; error: string; trace: ModelCallTrace }
  | { kind: 'llm_unparseable'; rawText: string; trace: ModelCallTrace }
  | { kind: 'schema_invalid'; rawText: string; trace: ModelCallTrace };

/**
 * Per-call parse-retry policy. When `enabled` is true the wrapper retries on
 * `llm_unparseable` and `schema_invalid` outcomes up to `maxAttempts` total
 * attempts (including the first call), bounded by `totalBudgetMs` wall-clock.
 * Default is a single attempt to preserve the legacy behavior for callers
 * that have not been migrated to the stage-policy registry.
 *
 * Parse-retry uses the same prompt and inputs — the point is to ride out a
 * transient model glitch, not to coax different outputs.
 */
export interface ParseRetryPolicy {
  enabled: boolean;
  maxAttempts: number;
  totalBudgetMs: number;
}

export interface StructuredLlmCallParams<TSchema extends z.ZodTypeAny> {
  /** Prompt filename relative to `prompts/`. */
  promptFile: string;
  user: string;
  schema: TSchema;
  /** Stage label for tracing. */
  stage: string;
  /** Defaults to env LLM_MODEL. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: LlmTool[];
  /** Default 2. Transient transport-level retries inside callLlmWithRetry. */
  retries?: number;
  /** Per-call timeout override (ms). Defaults to env LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Bounded retry on parse / schema failures. Disabled by default. */
  parseRetryPolicy?: ParseRetryPolicy;
}

export async function structuredLlmCall<TSchema extends z.ZodTypeAny>(
  params: StructuredLlmCallParams<TSchema>,
): Promise<StructuredLlmOutcome<z.infer<TSchema>>> {
  const system = await loadPrompt(params.promptFile);

  const parseRetry: ParseRetryPolicy = params.parseRetryPolicy ?? {
    enabled: false,
    maxAttempts: 1,
    totalBudgetMs: Number.POSITIVE_INFINITY,
  };
  const maxAttempts = parseRetry.enabled ? Math.max(1, parseRetry.maxAttempts) : 1;
  const startedAt = Date.now();
  const retriedReasons: string[] = [];

  let attempts = 0;
  let lastLlm: Awaited<ReturnType<typeof callLlmWithRetry>> | null = null;
  let lastParseFailure: { reason: 'llm_unparseable' | 'schema_invalid'; rawText: string } | null = null;
  let totalLatencyMs = 0;
  let okData: z.infer<TSchema> | null = null;
  let okText: string | null = null;

  while (attempts < maxAttempts) {
    if (parseRetry.enabled && attempts > 0 && Date.now() - startedAt >= parseRetry.totalBudgetMs) {
      break;
    }

    attempts += 1;
    const llm = await callLlmWithRetry(
      {
        system,
        user: params.user,
        ...(params.model ? { model: params.model } : {}),
        maxTokens: params.maxTokens ?? 1024,
        temperature: params.temperature ?? 0,
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      },
      params.retries ?? 2,
    );
    lastLlm = llm;
    totalLatencyMs += llm.latencyMs;

    if (llm.status !== 'ok' || !llm.text) {
      // Transport-class failures aren't parse failures — exit the parse-retry
      // loop. callLlmWithRetry has already exhausted its transient retries.
      break;
    }

    const extract = extractJson(llm.text, params.schema);
    if (extract.ok) {
      okData = extract.data;
      okText = llm.text;
      lastParseFailure = null;
      break;
    }

    const reason: 'llm_unparseable' | 'schema_invalid' =
      extract.reason === 'schema_invalid' ? 'schema_invalid' : 'llm_unparseable';
    lastParseFailure = { reason, rawText: llm.text };

    if (!parseRetry.enabled || attempts >= maxAttempts) break;
    retriedReasons.push(reason);
  }

  const trace: ModelCallTrace = {
    model: lastLlm?.model ?? '',
    latency_ms: totalLatencyMs,
    status: lastLlm?.status ?? 'error',
    stage: params.stage,
    attempts,
    ...(retriedReasons.length > 0 ? { retried_reasons: retriedReasons } : {}),
  };

  if (okData !== null && okText !== null) {
    return { kind: 'ok', data: okData, trace, rawText: okText };
  }

  if (!lastLlm || lastLlm.status !== 'ok' || !lastLlm.text) {
    return {
      kind: 'llm_failed',
      error: lastLlm?.error ?? `provider returned ${lastLlm?.status ?? 'error'} with no text`,
      trace,
    };
  }

  return {
    kind: lastParseFailure?.reason === 'schema_invalid' ? 'schema_invalid' : 'llm_unparseable',
    rawText: lastParseFailure?.rawText ?? lastLlm.text,
    trace,
  };
}
