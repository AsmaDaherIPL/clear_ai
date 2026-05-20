/**
 * Stage 3 — Sanity check (lightweight LLM, value-plausibility only).
 *
 * Runs after Stage 2 reconciliation accepted a final code. The orchestrator
 * skips this stage when no code was decided (escalated reconciliation), so
 * by the time we run, both the code and the description are settled.
 *
 * One job: judge whether the declared value is plausible for the item
 * described. The Rolex-for-$50 / unbranded-T-shirt-for-$4000 catcher —
 * order-of-magnitude only, NOT a price audit. We do NOT re-litigate
 * the code.
 *
 * Returns PASS | FLAG. The code stands either way — FLAG just routes the
 * item to HITL for human review with the code intact. There is no BLOCK
 * path: BLOCK on PipelineResult.sanity_verdict is reserved for upstream
 * pre-classification rejections (parse failure, cleanup unusable) that
 * the orchestrator emits BEFORE this stage runs. The LLM never produces
 * BLOCK.
 *
 * Model: Haiku (LLM_MODEL). Sufficient for ~10x order-of-magnitude
 * plausibility judgments. The prompt biases toward PASS — borderline
 * prices in normal retail bands are PASS; only ~10x mismatches FLAG.
 * False positives waste reviewer time and desensitise the queue.
 *
 * Failure mode: never throws. On exhaustion of retries, degrades to PASS
 * with `degraded: true` rather than FLAG. FLAG-on-failure produced false-
 * positive HITL queue entries every time Foundry hiccuped; the verdict
 * should reflect plausibility of the value, not the health of the LLM.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../../../inference/llm/structured-call.js';
import { getLlmStagePolicy } from '../../../inference/llm/policy.js';
import { env } from '../../../config/env.js';
import type { SanityResult } from '../shared/pipeline.types.js';

const SanitySchema = z
  .object({
    verdict: z.enum(['PASS', 'FLAG']).optional(),
    rationale: z.unknown().optional(),
  })
  .passthrough();

export async function runSanity(params: {
  final_code: string;
  cleaned_description: string;
  /**
   * Verbatim merchant line. Carries the brand / model / SKU that cleanup
   * strips. Sanity needs both: cleaned for the customs noun, raw for the
   * retail tier (Casio Pro Trek vs unbranded digital both clean to
   * "digital watch" but anchor very different bands).
   */
  raw_description: string | null;
  value_amount: number | null;
  currency_code: string | null;
}): Promise<SanityResult> {
  const start = Date.now();
  const model = env().LLM_MODEL;
  const policy = getLlmStagePolicy('sanity');

  const user = JSON.stringify({
    final_code: params.final_code,
    raw_description: params.raw_description,
    cleaned_description: params.cleaned_description,
    value_amount: params.value_amount,
    currency_code: params.currency_code,
  });

  const outcome = await structuredLlmCall({
    promptFile: 'sanity.md',
    user,
    schema: SanitySchema,
    stage: 'sanity',
    model,
    maxTokens: 256,
    timeoutMs: policy.timeoutMs,
    parseRetryPolicy: {
      enabled: policy.retryOnParseFailure,
      maxAttempts: policy.maxAttempts,
      totalBudgetMs: policy.totalBudgetMs,
    },
  });

  const latency_ms = Date.now() - start;
  const attempts = outcome.trace.attempts;
  const retried_reasons = outcome.trace.retried_reasons;

  if (outcome.kind !== 'ok') {
    // graceful_degrade: default to PASS rather than FLAG. A failing LLM is
    // not evidence of an implausible value, so we should not punish the
    // merchant for our infra. Operators see degraded=true in the trace.
    return {
      verdict: 'PASS',
      rationale: 'sanity check skipped: LLM unavailable',
      latency_ms,
      degraded: true,
      attempts,
      ...(retried_reasons && retried_reasons.length > 0 ? { retried_reasons } : {}),
    };
  }

  const d = outcome.data;
  // Anything that isn't a clean PASS becomes FLAG (parse miss, malformed
  // verdict, model returned BLOCK by mistake, etc.). When in doubt, FLAG.
  let verdict: 'PASS' | 'FLAG' = d.verdict === 'PASS' ? 'PASS' : 'FLAG';
  const rationale = typeof d.rationale === 'string' ? d.rationale : '';

  // PR8 / 2026-05-20 — rationale-verdict reconciliation.
  //
  // The sanity prompt has a self-check rule ("verdict MUST match what
  // rationale concludes") but the model violates it on borderline
  // multi-revision cases. Today's 10-row batch surfaced two examples:
  //   #2 L'Oreal hair color 200 SAR: rationale revised the band four
  //      times, every revision concluded PASS, structured verdict came
  //      back FLAG.
  //   #5 Arabic hoody 699 SAR: same pattern — three "Band X → PASS"
  //      revisions in rationale, verdict FLAG.
  //
  // When rationale narrates PASS but verdict says FLAG, trust the
  // rationale. The model's structured field is the unreliable one
  // here — it's a single-token choice the model defaults toward FLAG
  // on uncertainty; the rationale is the actual reasoning trace.
  //
  // Symmetric direction (rationale concludes FLAG but verdict PASS) is
  // NOT overridden. That would weaken the "when in doubt, FLAG" stance
  // on parse/schema failure paths above. Only the false-positive
  // direction gets reconciled.
  let verdictReconciled = false;
  if (verdict === 'FLAG' && rationale) {
    if (rationaleConcludesPass(rationale)) {
      verdict = 'PASS';
      verdictReconciled = true;
    }
  }

  return {
    verdict,
    rationale,
    latency_ms,
    attempts,
    ...(retried_reasons && retried_reasons.length > 0 ? { retried_reasons } : {}),
    ...(verdictReconciled ? { verdict_reconciled: true } : {}),
  };
}

/**
 * True when the rationale text concludes PASS — i.e. its final assertion
 * is "inside [0.2, 5.0]" or contains "→ PASS" / "PASS." as the closing
 * statement.
 *
 * We deliberately do NOT use "rationale contains 'PASS'" because the
 * model regularly writes out the rule itself ("ratios inside [0.2,5.0]
 * → PASS, outside → FLAG") even when its actual verdict is FLAG. We
 * need the final-state interpretation.
 *
 * Heuristic: look at the last ~80 chars only. That's enough to capture
 * "Final: ... PASS." or "ratio 1.17×; inside [0.2,5.0]" while ignoring
 * the rule-statement prefix.
 */
function rationaleConcludesPass(rationale: string): boolean {
  const tail = rationale.slice(-80).toLowerCase();
  const concludesPass =
    /(→|->)\s*pass\b/.test(tail) ||
    /\bpass\.\s*$/.test(tail.trim()) ||
    /\binside\s*\[0\.2\s*,\s*5\.0\]/.test(tail);
  const concludesFlag = /(→|->)\s*flag\b/.test(tail) || /\bflag\.\s*$/.test(tail.trim());
  // If both signals present in the tail, don't override — ambiguous.
  return concludesPass && !concludesFlag;
}
