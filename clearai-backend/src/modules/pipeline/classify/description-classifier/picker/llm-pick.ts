import { z } from 'zod';
import { callLlmWithRetry, type LlmCallResult, type LlmStatus } from '../../../../inference/llm/client.js';
import { extractJson } from '../../../../inference/llm/parse-json.js';
import { loadPrompt } from '../../../../inference/llm/structured-call.js';
import type { Candidate } from '../../../../inference/retrieval/retrieve.js';
import type { MissingAttribute } from '../../shared/domain.types.js';
import type { CandidateFitVerdict } from '../../shared/pipeline.types.js';

export interface CandidateVerdict {
  code: string;
  fit: CandidateFitVerdict;
  rationale: string;
}

export interface LlmClassifyResult {
  llmStatus: LlmStatus;
  llmModel: string;
  latencyMs: number;
  parseFailed: boolean;
  /** Per-candidate verdicts. Empty on parse failure or LLM error. */
  verdicts: CandidateVerdict[];
  missingAttributes: MissingAttribute[];
  rawText: string | null;
  rawError?: string;
}

const MISSING_ENUM = new Set<MissingAttribute>([
  'material',
  'intended_use',
  'product_type',
  'dimensions',
  'composition',
]);

const FIT_VALUES = new Set<CandidateFitVerdict>(['fits', 'partial', 'does_not_fit']);

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

/**
 * One full call+parse cycle: LLM call → text extraction → schema parse →
 * verdict validation. Returns either a usable result or one of three
 * "unusable" sentinels (`llm_failed` | `empty_text` | `parse_failed`)
 * the outer retry loop uses to decide whether to try again.
 *
 * Hard-failure classes (HTTP 401/403/404, schema-invalid responses) and
 * empty-verdicts results are both common picker failure modes that are
 * retryable — same prompt, same input, often gets a real response on
 * second attempt. The outer retry runs at most once.
 */
async function attemptClassify(params: {
  system: string;
  user: string;
  model?: string;
}): Promise<
  | { kind: 'ok'; result: LlmClassifyResult }
  | { kind: 'llm_failed'; result: LlmClassifyResult }
  | { kind: 'empty_text'; result: LlmClassifyResult }
  | { kind: 'parse_failed'; result: LlmClassifyResult }
  | { kind: 'empty_verdicts'; result: LlmClassifyResult }
> {
  const llmResult: LlmCallResult = await callLlmWithRetry({
    system: params.system,
    user: params.user,
    ...(params.model ? { model: params.model } : {}),
    maxTokens: 1500,
    temperature: 0,
  });

  const isEmptyOk = llmResult.status === 'ok' && !llmResult.text;
  if (llmResult.status !== 'ok' || isEmptyOk) {
    const result: LlmClassifyResult = {
      llmStatus: isEmptyOk ? 'error' : llmResult.status,
      llmModel: llmResult.model,
      latencyMs: llmResult.latencyMs,
      parseFailed: false,
      verdicts: [],
      missingAttributes: [],
      rawText: null,
      ...(isEmptyOk
        ? { rawError: 'provider returned status=ok with no text block' }
        : llmResult.error
          ? { rawError: llmResult.error }
          : {}),
    };
    return { kind: isEmptyOk ? 'empty_text' : 'llm_failed', result };
  }

  const text = llmResult.text!;
  const extract = extractJson(text, ParsedClassifierSchema);
  if (!extract.ok) {
    return {
      kind: 'parse_failed',
      result: {
        llmStatus: 'ok',
        llmModel: llmResult.model,
        latencyMs: llmResult.latencyMs,
        parseFailed: true,
        verdicts: [],
        missingAttributes: [],
        rawText: llmResult.text,
      },
    };
  }

  // The redacted-call cache (test mocks etc) sometimes returns the LlmCallResult
  // shape but without a body that has structured-call's runtime stats. Defensive.
  return validateAndShape(llmResult, extract.data);
}

function validateAndShape(
  llmResult: LlmCallResult,
  parsed: { verdicts?: unknown; missing_attributes?: unknown },
): { kind: 'ok' | 'empty_verdicts'; result: LlmClassifyResult } {
  // Note: callers don't have direct access to the candidate set here;
  // the outer llmClassify passes it in via closure. We accept whatever
  // verdicts the LLM produced and let the closure-scoped validCodes
  // filter happen in the outer function below.
  const rawVerdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  const result: LlmClassifyResult = {
    llmStatus: 'ok',
    llmModel: llmResult.model,
    latencyMs: llmResult.latencyMs,
    parseFailed: false,
    verdicts: [], // populated by outer caller after candidate-set filter
    missingAttributes: [],
    rawText: llmResult.text,
  };
  // Stash raw verdicts on the result so the outer caller can filter them.
  // We use a non-typed extra field via assignment (LlmClassifyResult is open).
  (result as unknown as { _rawVerdicts: unknown[] })._rawVerdicts = rawVerdicts;
  (result as unknown as { _rawMissing: unknown[] })._rawMissing = Array.isArray(
    parsed.missing_attributes,
  )
    ? parsed.missing_attributes
    : [];
  return { kind: rawVerdicts.length === 0 ? 'empty_verdicts' : 'ok', result };
}

export async function llmClassify(params: {
  kind: 'describe' | 'expand';
  query: string;
  candidates: Candidate[];
  parentPrefix?: string;
  model?: string;
}): Promise<LlmClassifyResult> {
  const pickerFile = params.kind === 'describe' ? 'picker-describe.md' : 'picker-expand.md';
  const [gir, picker] = await Promise.all([
    loadPrompt('gir-system.md'),
    loadPrompt(pickerFile),
  ]);
  const system = `${gir}\n\n---\n\n${picker}`;
  const user = buildUser(params.query, params.candidates, params.parentPrefix);
  const validCodes = new Set(params.candidates.map((c) => c.code));

  // Retry-once policy. We retry on three recoverable picker failure modes:
  //   - empty_text     (status=ok with no body — provider hiccup)
  //   - parse_failed   (LLM returned non-JSON — usually a once-off)
  //   - empty_verdicts (LLM returned valid JSON but with no verdicts —
  //                     observed in 1-of-3 reproducibility runs at the
  //                     same input; same prompt + temperature 0 typically
  //                     produces real verdicts on retry)
  // Hard llm_failed (401/403/404) is NOT retried at this layer — the
  // circuit breaker (PR C) handles those at the dispatch entry point.
  let attempt = await attemptClassify({ system, user, ...(params.model ? { model: params.model } : {}) });
  if (
    attempt.kind === 'empty_text' ||
    attempt.kind === 'parse_failed' ||
    attempt.kind === 'empty_verdicts'
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[picker] ${attempt.kind} on first attempt; retrying once. model=${attempt.result.llmModel} kind=${params.kind}`,
    );
    const retry = await attemptClassify({ system, user, ...(params.model ? { model: params.model } : {}) });
    // Take the retry result if it's better; otherwise keep the first attempt.
    if (retry.kind === 'ok') {
      attempt = retry;
    } else if (attempt.kind === 'empty_verdicts' && retry.kind !== 'empty_verdicts') {
      // Even a parse_failed retry is no better than empty_verdicts on the
      // first attempt — keep the first.
    } else if (retry.kind === 'empty_verdicts' || retry.kind === 'parse_failed' || retry.kind === 'empty_text') {
      // Both attempts failed in similar ways — keep whichever has more
      // signal (the second is at least as recent).
      attempt = retry;
    }
  }

  if (attempt.kind === 'llm_failed' || attempt.kind === 'empty_text' || attempt.kind === 'parse_failed') {
    return attempt.result;
  }

  // attempt.kind is 'ok' or 'empty_verdicts' — both have raw verdicts on the result.
  const rawVerdicts = (attempt.result as unknown as { _rawVerdicts?: unknown[] })._rawVerdicts ?? [];
  const rawMissing = (attempt.result as unknown as { _rawMissing?: unknown[] })._rawMissing ?? [];

  const verdicts: CandidateVerdict[] = rawVerdicts
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

  const missingAttributes = rawMissing.filter(
    (x): x is MissingAttribute => typeof x === 'string' && MISSING_ENUM.has(x as MissingAttribute),
  );

  // Strip the closure-internal fields before returning to caller.
  const { _rawVerdicts, _rawMissing, ...cleanResult } = attempt.result as unknown as LlmClassifyResult & {
    _rawVerdicts?: unknown[];
    _rawMissing?: unknown[];
  };
  void _rawVerdicts;
  void _rawMissing;
  return {
    ...cleanResult,
    verdicts,
    missingAttributes,
  };
}

// Re-export buildUser so track-b expand path can continue using it if needed.
export { buildUser as buildPickerUser };
