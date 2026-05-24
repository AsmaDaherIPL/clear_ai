/**
 * LLM-based disambiguation for merchant code resolution.
 *
 * When a deprecated 12-digit code has multiple replacements, or when a
 * short prefix has multiple children, we fire a single LLM pick to
 * choose the most relevant candidate given the item's identify result.
 *
 * Moved from classify/description-classifier/picker/llm-pick.ts (the
 * full picker) in PR 13 into the merchant namespace. This file contains
 * only the subset of llm-pick logic used by merchant resolution:
 *   - pickAmongReplacements (multi-replacement disambiguation)
 *   - pickUnderPrefix (prefix-walk leaf pick)
 *
 * The broader picker (used by the pick stage) lives at pick/pick.ts.
 */
import { z } from 'zod';
import { callLlmWithRetry, type LlmCallResult, type LlmStatus } from '../../../inference/llm/client.js';
import { extractJson } from '../../../inference/llm/parse-json.js';
import { loadPrompt } from '../../../inference/llm/structured-call.js';
import { getLlmStagePolicy, type LlmStage } from '../../../inference/llm/policy.js';
import type { Candidate } from '../../../inference/retrieval/retrieve.js';
import type { CandidateFitVerdict } from '../shared/pipeline.types.js';
import type { HsCodeRecord } from './codebook.js';
import type { IdentifyResult } from '../types.js';

interface CandidateVerdict {
  code: string;
  fit: CandidateFitVerdict;
  rationale: string;
}

interface LlmClassifyResult {
  llmStatus: LlmStatus;
  llmModel: string;
  latencyMs: number;
  parseFailed: boolean;
  verdicts: CandidateVerdict[];
  attempts: number;
  retriedReasons: string[];
}

const FIT_VALUES = new Set<CandidateFitVerdict>([
  'fits',
  'partial_family',
  'chapter_adjacent',
  'does_not_fit',
  'partial',
]);

const ParsedClassifierSchema = z
  .object({
    verdicts: z.unknown().optional(),
    missing_attributes: z.unknown().optional(),
  })
  .passthrough();

function buildUser(
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
  parseFailed: boolean;
}

async function attemptClassify(params: {
  stage: LlmStage;
  system: string;
  user: string;
  timeoutMs: number;
}): Promise<AttemptOutcome> {
  // retries=0 on this layer: the OUTER while(attempts < policy.maxAttempts)
  // loop in llmClassify() is the policy-driven retry. The previous default
  // (retries=4) compounded with the outer loop to 5×maxAttempts = up to
  // 15 transport calls per merchant_resolution invocation. Batch
  // 019e3103 showed p95=50s, max=67s as a direct consequence. 429 retries
  // still happen transparently inside callLlm.
  const llmResult: LlmCallResult = await callLlmWithRetry({
    stage: params.stage,
    system: params.system,
    user: params.user,
    maxTokens: 600,
    temperature: 0,
    timeoutMs: params.timeoutMs,
  }, 0);

  const isEmptyOk = llmResult.status === 'ok' && !llmResult.text;
  if (llmResult.status !== 'ok' || isEmptyOk) {
    return { kind: isEmptyOk ? 'empty_text' : 'llm_failed', llmResult, rawVerdicts: [], parseFailed: false };
  }

  const extract = extractJson(llmResult.text!, ParsedClassifierSchema);
  if (!extract.ok) {
    return { kind: 'parse_failed', llmResult, rawVerdicts: [], parseFailed: true };
  }

  const rawVerdicts = Array.isArray(extract.data.verdicts) ? extract.data.verdicts : [];
  return {
    kind: rawVerdicts.length === 0 ? 'empty_verdicts' : 'ok',
    llmResult,
    rawVerdicts,
    parseFailed: false,
  };
}

function pickBetter(a: AttemptOutcome | null, b: AttemptOutcome): AttemptOutcome {
  if (!a) return b;
  const rank: Record<AttemptKind, number> = { ok: 5, empty_verdicts: 4, parse_failed: 3, empty_text: 2, llm_failed: 1 };
  return rank[b.kind] >= rank[a.kind] ? b : a;
}

async function llmClassify(params: {
  kind: 'describe' | 'expand';
  query: string;
  candidates: Candidate[];
  parentPrefix?: string;
  stage?: LlmStage;
}): Promise<LlmClassifyResult> {
  const stage: LlmStage = params.stage ?? 'merchant_replacement_pick';
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
    const outcome = await attemptClassify({ stage, system, user, timeoutMs: policy.timeoutMs });
    totalLatencyMs += outcome.llmResult.latencyMs;

    if (outcome.kind === 'llm_failed') { best = outcome; break; }
    if (outcome.kind === 'ok') { best = outcome; break; }

    best = pickBetter(best, outcome);
    if (!policy.retryOnParseFailure || attempts >= policy.maxAttempts) break;
    const reason =
      outcome.kind === 'parse_failed' ? 'llm_unparseable'
      : outcome.kind === 'empty_text' ? 'empty_text'
      : outcome.kind === 'empty_verdicts' ? 'empty_verdicts'
      : null;
    if (reason) retriedReasons.push(reason);
  }

  const finalOutcome = best!;
  const llmResult = finalOutcome.llmResult;

  if (finalOutcome.kind === 'llm_failed' || finalOutcome.kind === 'empty_text') {
    return {
      llmStatus: llmResult.status === 'ok' ? 'error' : llmResult.status,
      llmModel: llmResult.model,
      latencyMs: totalLatencyMs,
      parseFailed: false,
      verdicts: [],
      attempts,
      retriedReasons,
    };
  }

  if (finalOutcome.kind === 'parse_failed') {
    return {
      llmStatus: 'ok',
      llmModel: llmResult.model,
      latencyMs: totalLatencyMs,
      parseFailed: true,
      verdicts: [],
      attempts,
      retriedReasons,
    };
  }

  const verdicts: CandidateVerdict[] = finalOutcome.rawVerdicts
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

  return {
    llmStatus: 'ok',
    llmModel: llmResult.model,
    latencyMs: totalLatencyMs,
    parseFailed: false,
    verdicts,
    attempts,
    retriedReasons,
  };
}

/**
 * Build a minimal Candidate from a codebook row so the LLM picker can
 * be reused for the multi-replacement disambiguation case.
 */
function rowToCandidate(row: HsCodeRecord, rank: number): Candidate {
  return {
    code: row.code,
    description_en: row.description_en,
    description_ar: row.description_ar,
    parent10: row.code.slice(0, 10),
    path_en: '',
    path_ar: '',
    path_codes: [],
    vec_rank: null,
    bm25_rank: null,
    trgm_rank: null,
    vec_score: null,
    bm25_score: null,
    trgm_score: null,
    rrf_score: 1 / (rank + 1),
  };
}

/**
 * Extract the canonical retrieval-query string from an identify result.
 * clean_product -> canonical; uninformative/multi_product -> null.
 */
function queryFromIdentify(identify: IdentifyResult): string | null {
  if (identify.kind === 'clean_product') return identify.canonical;
  return null;
}

/**
 * Pick one of multiple replacement codes given an item's identify result.
 * Returns null without firing an LLM call when identify carries no signal.
 */
export async function pickAmongReplacements(
  replacements: string[],
  identify: IdentifyResult,
): Promise<string | null> {
  const query = queryFromIdentify(identify);
  if (query === null || query.length === 0) return null;

  const candidates = replacements.map((c, i) =>
    rowToCandidate(
      { code: c, is_deleted: false, replacement_codes: null, description_en: null, description_ar: null },
      i,
    ),
  );
  const result = await llmClassify({ kind: 'describe', query, candidates, stage: 'merchant_replacement_pick' });
  if (result.llmStatus !== 'ok' || result.parseFailed) return null;
  const topFit =
    result.verdicts.find((v) => v.fit === 'fits') ?? result.verdicts.find((v) => v.fit === 'partial');
  return topFit ? topFit.code : null;
}

/**
 * Pick a leaf under a parent prefix when the prefix has multiple children.
 * Returns null without firing an LLM call when identify carries no signal.
 */
export async function pickUnderPrefix(
  children: HsCodeRecord[],
  matchedPrefix: string,
  identify: IdentifyResult,
): Promise<string | null> {
  const query = queryFromIdentify(identify);
  if (query === null || query.length === 0) return null;

  const candidates = children.slice(0, 20).map((r, i) => rowToCandidate(r, i));
  const result = await llmClassify({
    kind: 'expand',
    query,
    candidates,
    parentPrefix: matchedPrefix,
    stage: 'merchant_replacement_pick',
  });
  if (result.llmStatus !== 'ok' || result.parseFailed) return null;
  const topFit =
    result.verdicts.find((v) => v.fit === 'fits') ?? result.verdicts.find((v) => v.fit === 'partial');
  return topFit ? topFit.code : null;
}
