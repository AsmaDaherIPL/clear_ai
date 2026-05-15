/**
 * Pipeline rewrite — Stage 7: picker (multi-arm aware) (PR 9).
 *
 * Sonnet, single LLM call (with bounded parse-retry on JSON failure),
 * receives a deduped + reranked candidate set (up to 8) spanning
 * potentially multiple chapters. Output: PickResult discriminated
 * union.
 *
 * Architectural delta vs current anchored picker:
 *   - Receives RerankedCandidate[] (already through PR 8) — no
 *     retrieval inside this module
 *   - candidates carry source_arm tags; picker prompt explains the
 *     multi-arm context
 *   - PickAccepted carries picked_from_arm + merchant_chapter_disagreement
 *     + candidate_count_by_arm (new fields per Q4 decisions 2026-05-15)
 *
 * Picker NEVER overrides identify or scope choices. It picks from
 * what's offered or escalates. The verifier (PR 10) handles routing
 * (PASS/UNCERTAIN); the picker emits the decision.
 *
 * Uses the `pick` LlmStage policy (Sonnet, 15s timeout, 3 parse-retry
 * attempts, 50s total budget).
 */
import { z } from 'zod';
import { env } from '../../../../config/env.js';
import { callLlmWithRetry, type LlmCallResult } from '../../../../inference/llm/client.js';
import { getLlmStagePolicy } from '../../../../inference/llm/policy.js';
import { extractJson } from '../../../../inference/llm/parse-json.js';
import { loadPrompt } from '../../../../inference/llm/structured-call.js';
import type {
  AnnotatedCandidate,
  IdentifyResult,
  PickAccepted,
  PickCallTrace,
  PickEscalate,
  PickResult,
  RerankedCandidate,
} from '../types.js';

/** Number of parse-retry attempts on JSON failure (in addition to the first). */
const PARSE_RETRY_LIMIT = 2;

/** Confidence assigned to a `fits` verdict (uncalibrated). */
const FITS_CONFIDENCE = 0.85;

/** Confidence assigned to a `partial` verdict (uncalibrated). */
const PARTIAL_CONFIDENCE = 0.55;

/**
 * Maximum length of an annotated_candidates rationale on the wire. The
 * picker prompt is told to write a short reason, but a chatty response
 * can blow up the payload — especially on 8-candidate prompts where 8 ×
 * unbounded strings could add 10-20KB. Truncating at 300 chars is the
 * same convention sanity / submission use. The full rationale stays in
 * the picker LLM call logs.
 */
const ANNOTATED_RATIONALE_MAX = 300;

const PickOutputSchema = z
  .object({
    verdicts: z.unknown().optional(),
    missing_attributes: z.unknown().optional(),
  })
  .passthrough();

interface ParsedVerdict {
  code: string;
  fit: 'fits' | 'partial' | 'does_not_fit';
  rationale: string;
}

type PositiveVerdict = ParsedVerdict & { fit: 'fits' | 'partial' };

interface PickInput {
  identify: IdentifyResult;
  candidates: RerankedCandidate[];
  /** First-2-digits of merchant code, for chapter_disagreement flag. Null when merchant absent. */
  merchant_chapter: string | null;
}

function buildQuery(identify: IdentifyResult): string {
  if (identify.kind === 'clean_product') {
    const tokens = identify.identity_tokens.length > 0 ? ` ${identify.identity_tokens.join(' ')}` : '';
    return `${identify.canonical}${tokens}`.trim();
  }
  // multi_product fallback: when identify could not commit to one product
  // (e.g. "Skirt + Shirt, both cotton") but the orchestrator still routed
  // us a candidate set (because merchant_resolution gave a clean prefix),
  // pick the first product as the query. Both items in a multi-product
  // line typically share a chapter — if they don't, the picker will
  // verdict everything does_not_fit and the row escalates. Better to try
  // than to refuse the call.
  //
  // Why first instead of joined: a joined query produces a Frankenstein
  // canonical that retrieval rerankers don't handle well. First-product
  // is the dominant signal and lets the picker reason about ONE thing.
  // Operator review (verifier_uncertain) catches the multi-product
  // composition.
  if (identify.kind === 'multi_product' && identify.products.length > 0) {
    return identify.products[0]!.trim();
  }
  return '';
}

function skippedTrace(): PickCallTrace {
  return {
    llm_called: false,
    latency_ms: 0,
    model: null,
    status: 'skipped',
    candidate_count: 0,
    audit_flag: false,
  };
}

function traceFromLlm(
  candidateCount: number,
  totalLatencyMs: number,
  llm: LlmCallResult,
  parsed: 'ok' | 'parse',
  auditFlag: boolean,
): PickCallTrace {
  let status: PickCallTrace['status'];
  if (llm.status === 'error') status = 'error';
  else if (llm.status === 'timeout') status = 'timeout';
  else if (parsed === 'parse') status = 'parse';
  else status = 'ok';
  return {
    llm_called: true,
    latency_ms: totalLatencyMs,
    candidate_count: candidateCount,
    status,
    model: llm.model,
    audit_flag: auditFlag,
  };
}

function coerceVerdict(raw: unknown, allowedCodes: Set<string>): ParsedVerdict | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const code = typeof obj.code === 'string' ? obj.code : null;
  const fit = obj.fit;
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : '';
  if (code === null || !allowedCodes.has(code)) return null;
  if (fit !== 'fits' && fit !== 'partial' && fit !== 'does_not_fit') return null;
  return { code, fit, rationale };
}

function parseVerdicts(text: string, allowedCodes: Set<string>): ParsedVerdict[] | null {
  const extracted = extractJson(text, PickOutputSchema);
  if (!extracted.ok) return null;
  const raw = (extracted.data as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(raw)) return null;
  const verdicts: ParsedVerdict[] = [];
  for (const v of raw) {
    const parsed = coerceVerdict(v, allowedCodes);
    if (parsed !== null) verdicts.push(parsed);
  }
  return verdicts;
}

function topPositive(verdicts: ParsedVerdict[]): PositiveVerdict | null {
  for (const v of verdicts) {
    if (v.fit === 'fits') return { code: v.code, fit: 'fits', rationale: v.rationale };
  }
  for (const v of verdicts) {
    if (v.fit === 'partial') return { code: v.code, fit: 'partial', rationale: v.rationale };
  }
  return null;
}

function tallyPopulation(
  verdicts: ParsedVerdict[],
): { fits: number; partial: number; does_not_fit: number } {
  let fits = 0;
  let partial = 0;
  let does_not_fit = 0;
  for (const v of verdicts) {
    if (v.fit === 'fits') fits += 1;
    else if (v.fit === 'partial') partial += 1;
    else if (v.fit === 'does_not_fit') does_not_fit += 1;
  }
  return { fits, partial, does_not_fit };
}

function extractGir(rationale: string): string {
  const match = rationale.match(/GIR\s*([1-6])\s*(?:\(([abc])\))?/i);
  if (!match) return '';
  const digit = match[1];
  const letter = match[2];
  return letter ? `GIR ${digit}(${letter.toLowerCase()})` : `GIR ${digit}`;
}

function countByArm(candidates: RerankedCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of candidates) {
    counts[c.source_arm] = (counts[c.source_arm] ?? 0) + 1;
  }
  return counts;
}

/**
 * Join the picker's per-candidate verdicts with the reranked candidate
 * metadata (descriptions, source_arm, rerank_score) so the wire carries
 * a complete row per evaluated candidate. Verdicts that arrived for
 * codes outside the candidate set are skipped — the picker is
 * constrained to allowedCodes upstream, so this should not happen in
 * practice; defensive only.
 *
 * Order mirrors the picker's verdict order so the picked candidate is
 * usually first; the UI sorts by fit + rerank_score for display.
 */
function buildAnnotatedCandidates(
  verdicts: ParsedVerdict[],
  candidates: RerankedCandidate[],
): AnnotatedCandidate[] {
  const byCode = new Map<string, RerankedCandidate>();
  for (const c of candidates) byCode.set(c.code, c);
  const annotated: AnnotatedCandidate[] = [];
  for (const v of verdicts) {
    const c = byCode.get(v.code);
    if (c === undefined) continue;
    annotated.push({
      code: v.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      fit: v.fit,
      rationale:
        v.rationale.length > ANNOTATED_RATIONALE_MAX
          ? `${v.rationale.slice(0, ANNOTATED_RATIONALE_MAX - 1)}…`
          : v.rationale,
      source_arm: c.source_arm,
      rerank_score: c.rerank_score,
    });
  }
  return annotated;
}

/**
 * Build the user payload for the picker prompt. Includes the
 * description, the candidate list with source_arm tags, and the path
 * hierarchies. Tokens trimmed reasonably to keep prompt size bounded.
 */
function buildUser(query: string, candidates: RerankedCandidate[]): string {
  const candidatesPayload = candidates.map((c, i) => ({
    n: i + 1,
    code: c.code,
    source_arm: c.source_arm,
    description_en: c.description_en,
    description_ar: c.description_ar,
    rrf_score: Number(c.rrf_score.toFixed(4)),
    rerank_score: Number(c.rerank_score.toFixed(4)),
  }));
  return JSON.stringify({
    description: query,
    candidates: candidatesPayload,
  });
}

async function attemptPick(params: {
  system: string;
  user: string;
  model: string;
  timeoutMs: number;
  allowedCodes: Set<string>;
}): Promise<{ llm: LlmCallResult; verdicts: ParsedVerdict[] | null }> {
  let attempt = 0;
  let lastLlm: LlmCallResult | null = null;
  let lastVerdicts: ParsedVerdict[] | null = null;
  while (attempt <= PARSE_RETRY_LIMIT) {
    const llm = await callLlmWithRetry(
      {
        stage: 'pick',
        system: params.system,
        user: params.user,
        model: params.model,
        maxTokens: 1500,
        temperature: 0,
        timeoutMs: params.timeoutMs,
      },
      0,
    );
    lastLlm = llm;
    if (llm.status !== 'ok' || llm.text === null || llm.text.length === 0) {
      return { llm, verdicts: null };
    }
    const verdicts = parseVerdicts(llm.text, params.allowedCodes);
    lastVerdicts = verdicts;
    if (verdicts !== null) return { llm, verdicts };
    attempt += 1;
  }
  return { llm: lastLlm!, verdicts: lastVerdicts };
}

/**
 * Find the source_arm of the candidate matching `code`, for the
 * picked_from_arm field on PickAccepted. Returns 'merchant_prefix' as
 * fallback when not found (shouldn't happen — code came from candidates).
 */
function armOf(
  code: string,
  candidates: RerankedCandidate[],
): PickAccepted['picked_from_arm'] {
  for (const c of candidates) {
    if (c.code === code) return c.source_arm;
  }
  return 'merchant_prefix';
}

/**
 * Run the picker.
 *
 * Inputs:
 *   identify              v2 IdentifyResult (used to build the query)
 *   candidates            reranked top 8 from PR 8
 *   merchant_chapter      first-2 of merchant code, or null
 *
 * Returns: PickResult (accepted | escalate)
 */
export async function runPick(input: PickInput): Promise<PickResult> {
  const t0 = Date.now();
  const { identify, candidates, merchant_chapter } = input;

  // Empty-query short-circuit: identify produced no description signal.
  // The orchestrator should also catch this and not call us, but we're
  // defensive — empty-query picker is unauditable guessing.
  const query = buildQuery(identify);
  if (query.length === 0) {
    const escalate: PickEscalate = {
      kind: 'escalate',
      reason: 'identify_no_query',
      detail: `identify produced no description-side signal (kind=${identify.kind}); refusing picker call`,
      // No LLM call → no verdicts to annotate.
      annotated_candidates: [],
      trace: skippedTrace(),
    };
    return escalate;
  }

  if (candidates.length === 0) {
    const escalate: PickEscalate = {
      kind: 'escalate',
      reason: 'no_candidates',
      detail: 'rerank returned 0 candidates',
      annotated_candidates: [],
      trace: skippedTrace(),
    };
    return escalate;
  }

  const policy = getLlmStagePolicy('pick');
  const system = await loadPrompt('pick.md');
  const user = buildUser(query, candidates);
  const allowedCodes = new Set(candidates.map((c) => c.code));

  const { llm, verdicts } = await attemptPick({
    system,
    user,
    model: env().LLM_MODEL_STRONG,
    timeoutMs: policy.timeoutMs,
    allowedCodes,
  });

  // Transport-level failure.
  if (llm.status !== 'ok' || llm.text === null || llm.text.length === 0) {
    const escalate: PickEscalate = {
      kind: 'escalate',
      reason: 'picker_unavailable',
      detail: `picker transport ${llm.status}: ${
        llm.error !== undefined && llm.error.length > 0 ? llm.error : '(no error string)'
      }`,
      // LLM call failed — no verdicts. (`verdicts` may be non-null
      // from a prior parse-retry attempt but transport-failed on the
      // final attempt; the parse-retry loop only returns verdicts when
      // status==='ok', so this branch is always empty.)
      annotated_candidates: [],
      trace: traceFromLlm(candidates.length, Date.now() - t0, llm, 'ok', false),
    };
    return escalate;
  }

  // Parse failure exhausted.
  if (verdicts === null) {
    const escalate: PickEscalate = {
      kind: 'escalate',
      reason: 'picker_unavailable',
      detail: `picker output unparseable after ${PARSE_RETRY_LIMIT + 1} attempts`,
      // Output couldn't be parsed; nothing to surface per-candidate.
      annotated_candidates: [],
      trace: traceFromLlm(candidates.length, Date.now() - t0, llm, 'parse', false),
    };
    return escalate;
  }

  // No positive verdict.
  const top = topPositive(verdicts);
  const verdict_population = tallyPopulation(verdicts);
  if (top === null) {
    const escalate: PickEscalate = {
      kind: 'escalate',
      reason: 'no_candidate_fits',
      detail: `picker returned no fits or partial verdicts (fits=${verdict_population.fits}, partial=${verdict_population.partial}, does_not_fit=${verdict_population.does_not_fit})`,
      // Picker ran end-to-end and verdicted every candidate as
      // does_not_fit. HITL reviewers will want to see exactly what was
      // rejected and why — this is the most useful escalate to annotate.
      annotated_candidates: buildAnnotatedCandidates(verdicts, candidates),
      trace: traceFromLlm(candidates.length, Date.now() - t0, llm, 'ok', false),
    };
    return escalate;
  }

  // Accepted: build the PickAccepted with the new audit fields.
  const pickedArm = armOf(top.code, candidates);
  const pickedChapter = top.code.slice(0, 2);
  const merchantChapterDisagreement =
    merchant_chapter !== null && pickedChapter !== merchant_chapter;
  // Audit flag fires when we picked from a non-merchant arm AND merchant
  // chapter disagrees — diagnostic signal for "merchant code was wrong."
  const auditFlag =
    pickedArm !== 'merchant_prefix' && merchantChapterDisagreement;

  const accepted: PickAccepted = {
    kind: 'accepted',
    final_code: top.code,
    fit: top.fit,
    confidence: top.fit === 'fits' ? FITS_CONFIDENCE : PARTIAL_CONFIDENCE,
    gir_applied: extractGir(top.rationale),
    verdict_population,
    picked_from_arm: pickedArm,
    merchant_chapter_disagreement: merchantChapterDisagreement,
    candidate_count_by_arm: countByArm(candidates),
    // Per-candidate verdicts the picker emitted. Includes the chosen
    // candidate (UI filters by code !== final_code when rendering as
    // "alternatives"). HITL reviewers see this list verbatim.
    annotated_candidates: buildAnnotatedCandidates(verdicts, candidates),
    trace: traceFromLlm(candidates.length, Date.now() - t0, llm, 'ok', auditFlag),
  };
  return accepted;
}
