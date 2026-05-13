import { z } from 'zod';
import { callLlmWithRetry, type LlmCallResult, type LlmStatus } from '../../../../../inference/llm/client.js';
import { extractJson } from '../../../../../inference/llm/parse-json.js';
import { loadPrompt } from '../../../../../inference/llm/structured-call.js';
import { getLlmStagePolicy, type LlmStage } from '../../../../../inference/llm/policy.js';
import type { Candidate } from '../../../../../inference/retrieval/retrieve.js';
import type { MissingAttribute } from '../../../shared/domain.types.js';
import type { CandidateFitVerdict } from '../../../shared/pipeline.types.js';

export interface CandidateVerdict {
  code: string;
  fit: CandidateFitVerdict;
  rationale: string;
}

export interface LlmClassifyResult {
  llmStatus: LlmStatus;
  llmModel: string;
  /** Wall-clock latency across every parse-retry attempt. */
  latencyMs: number;
  parseFailed: boolean;
  /** Per-candidate verdicts. Empty on parse failure or LLM error. */
  verdicts: CandidateVerdict[];
  missingAttributes: MissingAttribute[];
  rawText: string | null;
  rawError?: string;
  /** Total attempts including the first call (>=1). */
  attempts: number;
  /** Reason recorded for each attempt that triggered a parse retry. */
  retriedReasons: string[];
}

const MISSING_ENUM = new Set<MissingAttribute>([
  'material',
  'intended_use',
  'product_type',
  'dimensions',
  'composition',
]);

const FIT_VALUES = new Set<CandidateFitVerdict>([
  'fits',
  'partial_family',
  'chapter_adjacent',
  'does_not_fit',
  // 'partial' kept for backwards compatibility with picker traces that
  // predate the PR4 taxonomy widening. New picker output uses
  // 'partial_family'; consumers treat both identically.
  'partial',
]);

const ParsedClassifierSchema = z
  .object({
    verdicts: z.unknown().optional(),
    missing_attributes: z.unknown().optional(),
  })
  .passthrough();

export function buildUser(
  query: string,
  candidates: Candidate[],
  parentPrefix?: string,
): string {
  const parentLine = parentPrefix ? `Declared parent prefix: ${parentPrefix}\n\n` : '';

  const lines: string[] = candidates.map((c, i) => {
    const idx = `${i + 1}.`;
    const head = `${idx} code=${c.code}`;
    if (c.path_en || c.path_ar) {
      const en = c.path_en ? `\n   path_en: ${c.path_en}` : '';
      const ar = c.path_ar ? `\n   path_ar: ${c.path_ar}` : '';
      return `${head}${en}${ar}`;
    }
    const en = `\n   path_en: ${c.description_en ?? '(none)'}`;
    const ar = `\n   path_ar: ${c.description_ar ?? '(none)'}`;
    return `${head}${en}${ar}`;
  });

  return `${parentLine}User description:\n${query}\n\nCandidates:\n${lines.join('\n\n')}\n\nReturn JSON only.`;
}

type AttemptKind = 'ok' | 'llm_failed' | 'empty_text' | 'parse_failed' | 'empty_verdicts';

interface AttemptOutcome {
  kind: AttemptKind;
  llmResult: LlmCallResult;
  rawVerdicts: unknown[];
  rawMissing: unknown[];
  parseFailed: boolean;
}

async function attemptClassify(params: {
  stage: LlmStage;
  system: string;
  user: string;
  model?: string;
  timeoutMs: number;
}): Promise<AttemptOutcome> {
  const llmResult: LlmCallResult = await callLlmWithRetry({
    stage: params.stage,
    system: params.system,
    user: params.user,
    ...(params.model ? { model: params.model } : {}),
    maxTokens: 1500,
    temperature: 0,
    timeoutMs: params.timeoutMs,
  });

  const isEmptyOk = llmResult.status === 'ok' && !llmResult.text;
  if (llmResult.status !== 'ok' || isEmptyOk) {
    return {
      kind: isEmptyOk ? 'empty_text' : 'llm_failed',
      llmResult,
      rawVerdicts: [],
      rawMissing: [],
      parseFailed: false,
    };
  }

  const extract = extractJson(llmResult.text!, ParsedClassifierSchema);
  if (!extract.ok) {
    return {
      kind: 'parse_failed',
      llmResult,
      rawVerdicts: [],
      rawMissing: [],
      parseFailed: true,
    };
  }

  const rawVerdicts = Array.isArray(extract.data.verdicts) ? extract.data.verdicts : [];
  const rawMissing = Array.isArray(extract.data.missing_attributes)
    ? extract.data.missing_attributes
    : [];
  return {
    kind: rawVerdicts.length === 0 ? 'empty_verdicts' : 'ok',
    llmResult,
    rawVerdicts,
    rawMissing,
    parseFailed: false,
  };
}

/** Map an unsuccessful attempt to the reason recorded on retry. */
function reasonForRetry(kind: AttemptKind): string | null {
  switch (kind) {
    case 'parse_failed':
      return 'llm_unparseable';
    case 'empty_text':
      return 'empty_text';
    case 'empty_verdicts':
      return 'empty_verdicts';
    default:
      return null;
  }
}

export async function llmClassify(params: {
  kind: 'describe' | 'expand';
  query: string;
  candidates: Candidate[];
  parentPrefix?: string;
  model?: string;
  /**
   * Stage policy to apply. Defaults to 'picker' for the Track A entry path;
   * the code-resolver-internal picker call passes 'code_resolver' so its
   * retry/budget profile matches the resolver semantics.
   */
  stage?: LlmStage;
}): Promise<LlmClassifyResult> {
  const stage: LlmStage = params.stage ?? 'picker';
  const policy = getLlmStagePolicy(stage);
  const pickerFile = params.kind === 'describe' ? 'picker-describe.md' : 'picker-expand.md';
  const [gir, picker] = await Promise.all([
    loadPrompt('gir-system.md'),
    loadPrompt(pickerFile),
  ]);
  const system = `${gir}\n\n---\n\n${picker}`;
  const user = buildUser(params.query, params.candidates, params.parentPrefix);
  const validCodes = new Set(params.candidates.map((c) => c.code));

  const startedAt = Date.now();
  const retriedReasons: string[] = [];
  let attempts = 0;
  let totalLatencyMs = 0;
  let best: AttemptOutcome | null = null;

  while (attempts < policy.maxAttempts) {
    if (attempts > 0 && Date.now() - startedAt >= policy.totalBudgetMs) break;
    attempts += 1;
    const outcome = await attemptClassify({
      stage,
      system,
      user,
      ...(params.model ? { model: params.model } : {}),
      timeoutMs: policy.timeoutMs,
    });
    totalLatencyMs += outcome.llmResult.latencyMs;

    // Hard transport failure: callLlmWithRetry already exhausted its transient
    // retries; the breaker handles auth-class outcomes. Stop here.
    if (outcome.kind === 'llm_failed') {
      best = outcome;
      break;
    }

    // First clean parse with verdicts: done.
    if (outcome.kind === 'ok') {
      best = outcome;
      break;
    }

    // Keep the most recent outcome as the fallback if we exhaust attempts.
    best = pickBetter(best, outcome);

    // empty_text / parse_failed / empty_verdicts are all parse-class failures
    // under this policy — same prompt next attempt rides out the glitch.
    if (!policy.retryOnParseFailure || attempts >= policy.maxAttempts) break;
    const reason = reasonForRetry(outcome.kind);
    if (reason) retriedReasons.push(reason);
    // eslint-disable-next-line no-console
    console.warn(
      `[picker] ${outcome.kind} on attempt ${attempts}; retrying (max=${policy.maxAttempts}). model=${outcome.llmResult.model} kind=${params.kind} stage=${stage}`,
    );
  }

  // best is non-null because the loop runs at least once.
  const finalOutcome = best!;
  return shapeResult({
    outcome: finalOutcome,
    validCodes,
    attempts,
    retriedReasons,
    totalLatencyMs,
  });
}

/** Prefer ok > empty_verdicts > parse_failed > empty_text > llm_failed. */
function pickBetter(a: AttemptOutcome | null, b: AttemptOutcome): AttemptOutcome {
  if (!a) return b;
  const rank: Record<AttemptKind, number> = {
    ok: 5,
    empty_verdicts: 4,
    parse_failed: 3,
    empty_text: 2,
    llm_failed: 1,
  };
  return rank[b.kind] >= rank[a.kind] ? b : a;
}

function shapeResult(args: {
  outcome: AttemptOutcome;
  validCodes: Set<string>;
  attempts: number;
  retriedReasons: string[];
  totalLatencyMs: number;
}): LlmClassifyResult {
  const { outcome, validCodes, attempts, retriedReasons, totalLatencyMs } = args;
  const llmResult = outcome.llmResult;
  const isEmptyOk = llmResult.status === 'ok' && !llmResult.text;

  if (outcome.kind === 'llm_failed' || outcome.kind === 'empty_text') {
    return {
      llmStatus: isEmptyOk ? 'error' : llmResult.status,
      llmModel: llmResult.model,
      latencyMs: totalLatencyMs,
      parseFailed: false,
      verdicts: [],
      missingAttributes: [],
      rawText: null,
      ...(isEmptyOk
        ? { rawError: 'provider returned status=ok with no text block' }
        : llmResult.error
          ? { rawError: llmResult.error }
          : {}),
      attempts,
      retriedReasons,
    };
  }

  if (outcome.kind === 'parse_failed') {
    return {
      llmStatus: 'ok',
      llmModel: llmResult.model,
      latencyMs: totalLatencyMs,
      parseFailed: true,
      verdicts: [],
      missingAttributes: [],
      rawText: llmResult.text,
      attempts,
      retriedReasons,
    };
  }

  // ok or empty_verdicts: filter raw verdicts against the candidate set.
  const verdicts: CandidateVerdict[] = outcome.rawVerdicts
    .filter(
      (v): v is { code: string; fit: string; rationale: string } =>
        v != null &&
        typeof v === 'object' &&
        typeof (v as { code?: unknown }).code === 'string' &&
        typeof (v as { fit?: unknown }).fit === 'string' &&
        typeof (v as { rationale?: unknown }).rationale === 'string' &&
        validCodes.has((v as { code: string }).code) &&
        FIT_VALUES.has((v as { fit: string }).fit as CandidateFitVerdict),
    )
    .map((v) => ({
      code: v.code,
      fit: v.fit as CandidateFitVerdict,
      rationale: v.rationale.slice(0, 200),
    }));

  const missingAttributes = outcome.rawMissing.filter(
    (x): x is MissingAttribute => typeof x === 'string' && MISSING_ENUM.has(x as MissingAttribute),
  );

  return {
    llmStatus: 'ok',
    llmModel: llmResult.model,
    latencyMs: totalLatencyMs,
    parseFailed: false,
    verdicts,
    missingAttributes,
    rawText: llmResult.text,
    attempts,
    retriedReasons,
  };
}

// Re-export buildUser so track-b expand path can continue using it if needed.
export { buildUser as buildPickerUser };
