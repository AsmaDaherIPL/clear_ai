/**
 * Best-effort fallback (ADR-0011). Last-resort classifier returning a
 * 2/4/6/8/10-digit heading at confidence_band='low'. Runs when picker
 * fails (or gate refused) AND setup_meta.BEST_EFFORT_ENABLED=1.
 *
 * Frontend MUST gate this behind a verify-toggle.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';

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

const ParsedBestEffortSchema = z
  .object({
    code: z.unknown().optional(),
    specificity: z.unknown().optional(),
    rationale: z.unknown().optional(),
  })
  .passthrough();

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

  const user =
    `Max specificity: ${params.maxDigits}\n\n` +
    `User input:\n${params.rawInput.trim()}\n\n` +
    `Return JSON only.`;

  const outcome = await structuredLlmCall({
    promptFile: 'best-effort-heading.md',
    user,
    schema: ParsedBestEffortSchema,
    stage: 'best_effort',
    model: params.model,
    maxTokens: params.maxTokens,
    retries: 1,
    // Short Haiku extraction; fail fast at 8s. Best-effort is the
    // last-resort tail and should never be the bottleneck on a request
    // that already failed every other gate.
    timeoutMs: 8_000,
  });

  if (outcome.kind !== 'ok') {
    const errMessage =
      outcome.kind === 'llm_failed'
        ? outcome.error
        : `unparseable JSON: ${outcome.rawText.slice(0, 120)}`;
    return {
      kind: 'failed',
      error: errMessage,
      latencyMs: outcome.trace.latency_ms,
      model: outcome.trace.model,
    };
  }
  const parsed = outcome.data;
  const result = { latencyMs: outcome.trace.latency_ms, model: outcome.trace.model };

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
