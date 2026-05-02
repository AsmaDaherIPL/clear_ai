/**
 * Best-effort fallback. Returns a 2/4/6/8/10-digit heading at low confidence
 * when the picker fails or the gate refuses. Frontend gates behind a verify-toggle.
 *
 * Residual-heading guardrail (commit 4 of new-pipeline rollout):
 *   When the LLM returns a residual catch-all heading like "Other footwear"
 *   (6405) or any *5/*9 heading whose label starts with "Other ...", we
 *   downgrade to the chapter level (2 digits) and set `needsReview=true`
 *   so the frontend can surface a "verify before declaring" affordance.
 *   Per project rule "always return a code, alert if needs review, never
 *   refuse" — even a chapter-level answer beats no answer at all.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { applyResidualHeadingGuardrail } from '../util/residual-heading.js';

export type BestEffortOutcome =
  | {
      kind: 'ok';
      code: string;
      specificity: number;
      rationale: string;
      /**
       * True when the residual-heading guardrail downgraded the LLM's
       * original code to a safer chapter-level prefix. Caller (route)
       * surfaces this on the response envelope so the frontend shows a
       * "needs review" badge.
       */
      needsReview: boolean;
      /** Set when needsReview=true; explains the downgrade. Null otherwise. */
      reviewReason: string | null;
      latencyMs: number;
      model: string;
    }
  | { kind: 'failed'; error: string; latencyMs: number; model: string };

export interface BestEffortParams {
  rawInput: string;
  /** One of {2,4,6,8,10}. */
  maxDigits: number;
  maxTokens: number;
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

  // Apply the residual-heading guardrail. This may downgrade a code like
  // 6405 ("Other footwear") to its chapter (64) and set needsReview=true.
  // Pure pass-through when the LLM picked a non-residual heading.
  // Never throws — DB hiccups silently degrade to code-pattern detection.
  const guard = await applyResidualHeadingGuardrail(codeRaw);

  // When downgraded, prepend the guardrail's reason to the rationale
  // so the audit trail (and the frontend tooltip) carries both signals.
  const finalRationale = guard.needsReview
    ? `${guard.reviewReason ?? ''} Original LLM rationale: ${rationale}`.slice(0, 800)
    : rationale;

  return {
    kind: 'ok',
    code: guard.code,
    specificity: guard.specificity,
    rationale: finalRationale,
    needsReview: guard.needsReview,
    reviewReason: guard.reviewReason,
    latencyMs: result.latencyMs,
    model: result.model,
  };
}
