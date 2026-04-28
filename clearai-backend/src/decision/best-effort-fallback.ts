/**
 * Best-effort fallback (ADR-0011).
 *
 * Last-resort classifier. Runs only when:
 *   - the primary picker has already been attempted (or skipped because the
 *     gate failed), AND
 *   - `setup_meta.BEST_EFFORT_ENABLED = 1`.
 *
 * Returns a low-specificity heading (2/4/6/8/10 digit, capped by
 * `BEST_EFFORT_MAX_DIGITS`, default 4) with `confidence_band = 'low'`.
 *
 * The frontend MUST gate this output behind a verify-toggle so users do not
 * confuse a best-effort heading with an accepted classification.
 *
 * Stateless by design: never reads or writes any product-code cache. Each
 * request is handled from raw input only.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callLlmWithRetry } from '../llm/client.js';

const PROMPT_DIR = join(process.cwd(), 'prompts');

let _promptCache: string | null = null;
async function getBestEffortPrompt(): Promise<string> {
  if (_promptCache) return _promptCache;
  _promptCache = await readFile(join(PROMPT_DIR, 'best-effort-heading.md'), 'utf8');
  return _promptCache;
}

export type BestEffortOutcome =
  | {
      kind: 'ok';
      code: string;
      specificity: number;
      rationale: string;
      latencyMs: number;
      model: string;
    }
  | { kind: 'failed'; error: string; latencyMs: number; model: string };

export interface BestEffortParams {
  rawInput: string;
  /** From setup_meta.BEST_EFFORT_MAX_DIGITS. Must be one of {2,4,6,8,10}. */
  maxDigits: number;
  /** From setup_meta.BEST_EFFORT_MAX_TOKENS. */
  maxTokens: number;
  /** Foundry model id (passed through from describe.ts). */
  model: string;
}

interface ParsedJson {
  code: unknown;
  specificity: unknown;
  rationale: unknown;
}

function tryExtractJson(text: string): ParsedJson | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as ParsedJson;
  } catch {
    return null;
  }
}

const ALLOWED_DIGITS = new Set([2, 4, 6, 8, 10]);

export async function bestEffortHeading(
  params: BestEffortParams,
): Promise<BestEffortOutcome> {
  if (!ALLOWED_DIGITS.has(params.maxDigits)) {
    return {
      kind: 'failed',
      error: `BEST_EFFORT_MAX_DIGITS must be one of {2,4,6,8,10}; got ${params.maxDigits}.`,
      latencyMs: 0,
      model: params.model,
    };
  }

  const system = await getBestEffortPrompt();
  const user =
    `Max specificity: ${params.maxDigits}\n\n` +
    `User input:\n${params.rawInput.trim()}\n\n` +
    `Return JSON only.`;

  const result = await callLlmWithRetry(
    {
      model: params.model,
      system,
      user,
      maxTokens: params.maxTokens,
      temperature: 0,
    },
    1,
  );

  if (result.status !== 'ok' || !result.text) {
    return {
      kind: 'failed',
      error: result.error ?? 'no text from best-effort fallback',
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  const parsed = tryExtractJson(result.text);
  if (!parsed) {
    return {
      kind: 'failed',
      error: `unparseable JSON: ${result.text.slice(0, 120)}`,
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  // Validate code: must be all digits, length <= maxDigits, length even at
  // the canonical HS levels (2/4/6/8/10) OR exactly 2 for the 'unknown' case.
  const codeRaw = typeof parsed.code === 'string' ? parsed.code.trim() : '';
  if (!/^\d+$/.test(codeRaw)) {
    return {
      kind: 'failed',
      error: `code is not all digits: ${codeRaw.slice(0, 20)}`,
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }
  if (!ALLOWED_DIGITS.has(codeRaw.length)) {
    return {
      kind: 'failed',
      error: `code length ${codeRaw.length} not in {2,4,6,8,10}`,
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }
  if (codeRaw.length > params.maxDigits) {
    return {
      kind: 'failed',
      error: `code length ${codeRaw.length} exceeds max ${params.maxDigits}`,
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  const specificityRaw = parsed.specificity;
  const specificity =
    typeof specificityRaw === 'number' ? specificityRaw : Number(specificityRaw);
  if (!Number.isInteger(specificity) || specificity !== codeRaw.length) {
    return {
      kind: 'failed',
      error: `specificity ${specificity} does not match code length ${codeRaw.length}`,
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  const rationale =
    typeof parsed.rationale === 'string' && parsed.rationale.trim().length > 0
      ? parsed.rationale.trim().slice(0, 500)
      : 'Best-effort heading — verify before use.';

  return {
    kind: 'ok',
    code: codeRaw,
    specificity,
    rationale,
    latencyMs: result.latencyMs,
    model: result.model,
  };
}
