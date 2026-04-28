/**
 * `structuredLlmCall` — the canonical pattern for "call the model, parse JSON,
 * validate against a schema, return typed result with a known fallback shape."
 *
 * Six modules (cleanup, picker, branch-rank, best-effort, submission-desc,
 * researcher) each independently re-implemented this pattern with subtle
 * drift across copies. The drift is the bug surface: one module retried
 * twice, another retried once; one trimmed rationale to 500 chars, another
 * to 300; one silently dropped malformed rows, another threw.
 *
 * This helper centralises the pattern with these invariants:
 *
 *   1. Prompt files are loaded from `prompts/<name>.md` and cached in-process
 *      after first read. Module-level caches (V2) had the same lifetime but
 *      copy-pasted the cache logic; this is one cache table, addressable by
 *      filename.
 *
 *   2. The LLM call uses `callLlmWithRetry` with whatever retry policy the
 *      client decided on. Network-level retries are NOT this helper's job —
 *      it's about prompt + schema, not transport.
 *
 *   3. JSON extraction uses `extractJson` (the shared parser from
 *      Enhancement 5). Schema validation uses Zod. Failures are
 *      categorised: `llm_failed` (network/timeout), `llm_unparseable`
 *      (no JSON found), `schema_invalid` (JSON didn't match the schema).
 *
 *   4. The return is a tagged union so callers can branch on outcome.
 *      Successful calls carry the typed parsed data and a model-call trace
 *      record (model name, latency, status) for the central observability
 *      sink. Failed calls carry the same trace record so logging is
 *      uniform across success/failure.
 *
 * Phase F (web search) plugs in here naturally: pass `tools: [...]` and
 * the helper forwards them to the LLM client. The schema can describe
 * tool-result blocks in addition to the final assistant text. No new
 * boilerplate per tool-using module.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { callLlmWithRetry, type LlmTool } from './client.js';
import { extractJson } from './parse-json.js';

const PROMPT_DIR = join(process.cwd(), 'prompts');

/**
 * In-process prompt cache. Filename → file contents. Promises are stored
 * (not strings) so concurrent first-reads of the same prompt collapse to
 * a single fs read.
 */
const promptCache = new Map<string, Promise<string>>();

/**
 * Load a prompt file from `prompts/`, caching after first read. Same
 * lifetime semantics as the per-module caches it replaces (process-local,
 * cleared on restart).
 *
 * Exported so callers can pre-warm the cache at boot if they want
 * (matching the V2 module-load behaviour). Most callers don't need to.
 */
export async function loadPrompt(filename: string): Promise<string> {
  const existing = promptCache.get(filename);
  if (existing) return existing;
  const promise = readFile(join(PROMPT_DIR, filename), 'utf8');
  promptCache.set(filename, promise);
  // If the read fails, drop the rejected promise so a retry on the next
  // call gets a fresh attempt. Otherwise we'd cache a permanent failure.
  try {
    return await promise;
  } catch (err) {
    promptCache.delete(filename);
    throw err;
  }
}

/**
 * Per-call trace record. The route handler concatenates these into the
 * `modelCalls` block on the response and the event log. Centralising the
 * shape means individual modules don't each construct their own
 * `{model, latency_ms, status}` record with subtle differences.
 */
export interface ModelCallTrace {
  model: string;
  latency_ms: number;
  status: 'ok' | 'error' | 'timeout';
  /** Stage label for the trace, e.g. 'cleanup', 'picker', 'branch_rank'. */
  stage: string;
}

/**
 * Outcome shape for `structuredLlmCall`. Tagged union so callers can branch
 * precisely on the failure mode without parsing strings or remembering
 * which-empty-shape-meant-what.
 */
export type StructuredLlmOutcome<T> =
  | {
      kind: 'ok';
      data: T;
      trace: ModelCallTrace;
      /** Raw model text for offline analysis. */
      rawText: string;
    }
  | {
      kind: 'llm_failed';
      /** Brief error string from the LLM client. Useful for ops dashboards. */
      error: string;
      trace: ModelCallTrace;
    }
  | {
      kind: 'llm_unparseable';
      /** The model returned text but no extractable JSON object. */
      rawText: string;
      trace: ModelCallTrace;
    }
  | {
      kind: 'schema_invalid';
      /** Zod found JSON but it didn't match the schema. */
      rawText: string;
      trace: ModelCallTrace;
    };

export interface StructuredLlmCallParams<TSchema extends z.ZodTypeAny> {
  /**
   * Prompt filename relative to `prompts/`. Cached per-process after
   * first read.
   */
  promptFile: string;
  /** User message — the request payload the model reasons over. */
  user: string;
  /**
   * Zod schema the parsed JSON is validated against. The output type
   * `T = z.infer<TSchema>` is what the caller gets back on success.
   */
  schema: TSchema;
  /**
   * Stage label for tracing. Conventionally lowercase + underscore
   * (e.g. 'cleanup', 'branch_rank', 'submission_description').
   */
  stage: string;
  /**
   * Override the default model. Defaults to env LLM_MODEL when omitted.
   * Strong-model callers (picker, researcher, branch-rank) typically
   * pass `env().LLM_MODEL_STRONG`.
   */
  model?: string;
  /** Cap on output tokens. Defaults to 1024. */
  maxTokens?: number;
  /** Sampling temperature. Defaults to 0 for deterministic JSON output. */
  temperature?: number;
  /**
   * Optional tools forwarded to the LLM. Today only Anthropic's hosted
   * Web Search tool is supported. The model decides whether to invoke
   * the tool; tool-result blocks arrive in the response and the model
   * synthesises them into the final JSON answer (we don't post-process
   * tool blocks here — the model's text content is what we parse).
   */
  tools?: LlmTool[];
  /**
   * Number of retries for transient LLM-client failures (network /
   * 429 / 5xx). Defaults to 2. Schema-failed responses are NOT retried —
   * the model will likely produce the same shape on retry.
   */
  retries?: number;
}

/**
 * The canonical LLM call. See module docstring.
 */
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
