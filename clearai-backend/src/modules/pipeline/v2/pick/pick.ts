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
  ConfidenceSignals,
  IdentifyResult,
  PickAccepted,
  PickCallTrace,
  PickEscalate,
  PickResult,
  RerankedCandidate,
} from '../types.js';

/** Number of parse-retry attempts on JSON failure (in addition to the first). */
const PARSE_RETRY_LIMIT = 2;

/**
 * Confidence is computed, not constant. See computeConfidence() below.
 * Constants here are formula inputs; tune them with care because the
 * picker tests assert specific values.
 *
 *   BASE_*           - starting value keyed off the picker's fit verdict
 *   *_BONUS          - additive adjustments from trace signals
 *   LAST_CHANCE      - hard override when the orchestrator's last-chance
 *                      pass coerced a `partial` pick. Below
 *                      IDENTIFY_LOW_CONFIDENCE_HITL_THRESHOLD (0.60) so
 *                      HITL routing fires automatically.
 *   CONFIDENCE_MIN/MAX - never emit a confidence at 0.00 or 1.00. A 1.00
 *                      pick would be a bug if it's ever wrong; a 0.00
 *                      pick wouldn't be a pick.
 */
const BASE_FITS = 0.65;
const BASE_PARTIAL = 0.45;
/**
 * Base for a `does_not_fit` candidate when we evaluate "what confidence
 * would the formula assign if we'd picked this?" — used by
 * buildAnnotatedCandidates so non-winning candidates carry a number on
 * the wire. Bonuses still apply because they describe the same pool the
 * winner experiences, so a `does_not_fit` in a clean pool still scores
 * higher than one in an ambiguous pool — that's the comparison signal.
 */
const BASE_DOES_NOT_FIT = 0.15;
const LAST_CHANCE_CONFIDENCE = 0.40;

const POOL_CLEAN_BONUS = 0.10;           // 1 fits, 0 partial
const POOL_DOMINATED_BONUS = 0.05;       // >=70% does_not_fit in the pool
const ARM_AGREE_BONUS = 0.10;            // >=2 arms, chapters agree
const ARM_DISAGREE_PENALTY = -0.10;      // merchant chapter disagrees
const REREK_GAP_BONUS = 0.05;            // #1 score > #2 by >=10% relative

const CONFIDENCE_MIN = 0.05;
const CONFIDENCE_MAX = 0.99;

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
  /**
   * Orchestrator-supplied fallback query for the rare case where
   * identify is uninformative (no canonical, no products, no
   * identity_tokens) BUT the merchant supplied a clean prefix that
   * resolved to a valid leaf. The fallback is typically the merchant
   * leaf's English description (e.g. "footwear with outer soles of
   * leather" for prefix 640420). Lets the picker run a "is the
   * merchant's leaf plausible?" pass on its retrieved candidate set
   * instead of refusing.
   *
   * Optional so existing test fixtures don't have to pass it. Tests
   * exercising the brand-only rescue path should populate it; tests
   * for the normal clean_product path can omit it.
   */
  fallback_query?: string | null;
  /**
   * Last-chance pass: when the first picker call emitted all
   * does_not_fit despite candidates being present, the orchestrator
   * retries with this flag set. The picker's user message is augmented
   * with a "must pick" instruction, accepted partials land at
   * LAST_CHANCE_CONFIDENCE (0.40) so HITL routing fires automatically.
   * If the picker STILL refuses on the second pass, escalate honestly.
   */
  last_chance?: boolean;
}

function buildQuery(identify: IdentifyResult, fallback: string | null): string {
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
  // uninformative + merchant supplied a clean prefix: orchestrator
  // pre-computed fallback_query = the merchant leaf's catalog text.
  // We run the picker against retrieval filtered to that prefix and
  // let it verdict whichever sibling-leaf fits the input best. The
  // picked code will carry the computed `partial` confidence (typically
  // ~0.45 baseline) and downstream HITL routes it for operator review.
  if (fallback !== null && fallback.trim().length > 0) {
    return fallback.trim();
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
  verdict_population: { fits: number; partial: number; does_not_fit: number },
  merchant_chapter_disagreement: boolean,
): AnnotatedCandidate[] {
  const byCode = new Map<string, RerankedCandidate>();
  for (const c of candidates) byCode.set(c.code, c);
  const annotated: AnnotatedCandidate[] = [];
  for (const v of verdicts) {
    const c = byCode.get(v.code);
    if (c === undefined) continue;
    // Per-candidate confidence: run computeConfidence() as if THIS row
    // were the pick. Same formula as the winner. Lets the SPA compare
    // alternatives on a continuous axis (e.g. winner=0.50, alt1=0.45,
    // alt2=0.15). For does_not_fit verdicts we still emit a number — it
    // represents "how confident would the formula be if we'd picked
    // this?" which is naturally low because the base for does_not_fit
    // is the floor. Reviewers reading the trace can scan a single
    // column instead of mentally re-running the formula per row.
    const { confidence } = computeConfidence({
      fit: v.fit,
      verdict_population,
      candidates,
      merchant_chapter_disagreement,
    });
    annotated.push({
      code: v.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      path_en: c.path_en,
      path_ar: c.path_ar,
      fit: v.fit,
      confidence,
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
 * description, the candidate list with source_arm tags, and English
 * leaf labels. Token-budget-trimmed 2026-05-17:
 *   - description_ar removed (the picker classifies on English; Arabic
 *     was carried for trace/UI use and never referenced by the prompt)
 *   - rrf_score removed (only rerank_score is used downstream; rrf is
 *     an internal pre-rerank artifact the picker doesn't need)
 *
 * Per call: drops ~92 tokens (description_ar: ~77 + rrf_score: ~15)
 * Per 200-row batch: ~18,400 fewer input tokens.
 */
function buildUser(query: string, candidates: RerankedCandidate[], lastChance: boolean): string {
  const candidatesPayload = candidates.map((c, i) => ({
    n: i + 1,
    code: c.code,
    source_arm: c.source_arm,
    description_en: c.description_en,
    rerank_score: Number(c.rerank_score.toFixed(4)),
  }));
  const payload: Record<string, unknown> = {
    description: query,
    candidates: candidatesPayload,
  };
  if (lastChance) {
    // Second-pass override: the first call emitted all does_not_fit.
    // Force a pick at low confidence. This is the orchestrator's
    // "you know 79% of the answer, pick the least-wrong leaf" rescue.
    payload.must_pick = true;
    payload.must_pick_note =
      'You returned all does_not_fit on the first pass. The codebook has no perfect leaf for this product. Pick the single candidate whose chapter+heading overlaps most with the product\'s natural classification, emit `partial` with rationale "closest-available leaf — codebook has no perfect match", and explain in the rationale which chapter the product really belongs to so an operator can validate. DO NOT return another all-does_not_fit slate. If you genuinely cannot identify any candidate as plausibly related, pick the candidate with the highest rerank_score and emit `partial`.';
  }
  return JSON.stringify(payload);
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
    // Transport retries: 1 retry on timeout/5xx (so 2 total attempts).
    // Picker is idempotent. Before this change a single 15s timeout
    // (e.g. Foundry hiccup) escalated the row to picker_unavailable
    // with no retry — see 2026-05-16 batch (rows 139, 156). One retry
    // worst-case = 30s, fits inside the policy.totalBudgetMs=50000
    // ceiling. The outer while-loop's PARSE_RETRY_LIMIT covers parse
    // failures separately; this retry is purely for transport-class
    // errors that the inner callLlm doesn't already handle (429 is
    // handled there; 5xx + timeout + network errors live here).
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
      1,
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
  const fallback_query = input.fallback_query ?? null;
  const last_chance = input.last_chance ?? false;

  // Empty-query short-circuit: identify produced no description signal.
  // The orchestrator should also catch this and not call us, but we're
  // defensive — empty-query picker is unauditable guessing.
  const query = buildQuery(identify, fallback_query);
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
  const user = buildUser(query, candidates, last_chance);
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
      // No "winner" here so we pass false for merchant_chapter_disagreement;
      // every annotated candidate is a does_not_fit anyway so the bonuses
      // are computed against the same shared pool.
      annotated_candidates: buildAnnotatedCandidates(
        verdicts,
        candidates,
        verdict_population,
        /* merchant_chapter_disagreement */ false,
      ),
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

  // Confidence assignment. Last-chance pass always lands at
  // LAST_CHANCE_CONFIDENCE (0.40) regardless of trace signals because
  // we coerced the pick; operator MUST review. Otherwise compute from
  // signals — see computeConfidence() for the formula.
  const { confidence, signals } = last_chance
    ? {
        confidence: LAST_CHANCE_CONFIDENCE,
        signals: {
          base: LAST_CHANCE_CONFIDENCE,
          pool_cleanness_bonus: 0,
          arm_agreement_bonus: 0,
          rerank_gap_bonus: 0,
          raw_total: LAST_CHANCE_CONFIDENCE,
        } satisfies ConfidenceSignals,
      }
    : computeConfidence({
        fit: top.fit,
        verdict_population,
        candidates,
        merchant_chapter_disagreement: merchantChapterDisagreement,
      });
  const accepted: PickAccepted = {
    kind: 'accepted',
    final_code: top.code,
    fit: top.fit,
    confidence,
    confidence_signals: signals,
    gir_applied: extractGir(top.rationale),
    verdict_population,
    picked_from_arm: pickedArm,
    merchant_chapter_disagreement: merchantChapterDisagreement,
    candidate_count_by_arm: countByArm(candidates),
    // Per-candidate verdicts the picker emitted. Includes the chosen
    // candidate (UI filters by code !== final_code when rendering as
    // "alternatives"). HITL reviewers see this list verbatim. Each row
    // carries its own computed `confidence` so the SPA can compare
    // candidates on a continuous axis — see buildAnnotatedCandidates.
    annotated_candidates: buildAnnotatedCandidates(
      verdicts,
      candidates,
      verdict_population,
      merchantChapterDisagreement,
    ),
    trace: traceFromLlm(candidates.length, Date.now() - t0, llm, 'ok', auditFlag),
  };
  return accepted;
}

/**
 * Compute picker confidence from deterministic trace signals.
 *
 * Returns `confidence` (clamped to [CONFIDENCE_MIN, CONFIDENCE_MAX]) and
 * the per-signal breakdown so reviewers can audit the value.
 *
 * Inputs are all things the picker has already produced for the trace —
 * the LLM is NOT consulted for the number. The old 3-tier constant
 * (0.85 / 0.55 / 0.40) collapsed too much real differential signal:
 * a `fits` with 1 winner and 0 partial competitors and 3 cross-arm
 * agreement looked identical to a `fits` with 4 ambiguous competitors
 * and merchant chapter disagreement. They are very different rows.
 *
 * The formula:
 *   base               = 0.65 (fits) / 0.45 (partial)
 *   pool_clean_bonus   = +0.10 if exactly 1 fits and 0 partial
 *                      + 0.05 if >=70% of pool is does_not_fit
 *                        (decisive verdicting against most candidates)
 *   arm_agreement      = +0.10 if multi-arm AND merchant chapter agrees
 *                      = -0.10 if merchant chapter disagrees
 *   rerank_gap         = +0.05 if top1/top2 rerank gap is >= 10% relative
 *
 *   confidence = clamp(MIN, MAX, base + bonuses)
 *
 * Weights are educated starting points. Calibrate against
 * hitl_queue.reviewer_decision once you have ~500 labeled rows
 * (approve vs override) to fit a logistic regression and replace
 * these constants with the fitted coefficients.
 */
export function computeConfidence(input: {
  /**
   * The picker's verdict on the candidate being scored. `fits` and
   * `partial` are the winner cases; `does_not_fit` is used by
   * buildAnnotatedCandidates to assign comparable scores to losers.
   */
  fit: 'fits' | 'partial' | 'does_not_fit';
  verdict_population: { fits: number; partial: number; does_not_fit: number };
  candidates: ReadonlyArray<RerankedCandidate>;
  merchant_chapter_disagreement: boolean;
}): { confidence: number; signals: ConfidenceSignals } {
  const base =
    input.fit === 'fits' ? BASE_FITS
    : input.fit === 'partial' ? BASE_PARTIAL
    : BASE_DOES_NOT_FIT;

  // Pool cleanness — how decisive was the picker against the alternatives?
  const v = input.verdict_population;
  const totalVerdicted = v.fits + v.partial + v.does_not_fit;
  let pool_cleanness_bonus = 0;
  if (v.fits === 1 && v.partial === 0) {
    pool_cleanness_bonus += POOL_CLEAN_BONUS;
  }
  if (totalVerdicted > 0 && v.does_not_fit / totalVerdicted >= 0.7) {
    pool_cleanness_bonus += POOL_DOMINATED_BONUS;
  }

  // Cross-arm agreement — independent retrieval paths converging is strong
  // evidence. `merchant_chapter_disagreement` already encodes the harder
  // version of disagreement (the merchant's claimed chapter conflicts with
  // the winner); use it as the penalty signal.
  const armCount = new Set(input.candidates.map((c) => c.source_arm)).size;
  let arm_agreement_bonus = 0;
  if (input.merchant_chapter_disagreement) {
    arm_agreement_bonus = ARM_DISAGREE_PENALTY;
  } else if (armCount >= 2) {
    arm_agreement_bonus = ARM_AGREE_BONUS;
  }

  // Rerank gap — a pulled-away winner is a real winner. We sort because
  // candidates may not arrive rerank-score-desc (multi-arm union does
  // its own ordering).
  let rerank_gap_bonus = 0;
  if (input.candidates.length >= 2) {
    const sorted = [...input.candidates].sort((a, b) => b.rerank_score - a.rerank_score);
    const s1 = sorted[0]!.rerank_score;
    const s2 = sorted[1]!.rerank_score;
    if (s1 > 0 && (s1 - s2) / s1 >= 0.10) {
      rerank_gap_bonus = REREK_GAP_BONUS;
    }
  }

  const raw_total = base + pool_cleanness_bonus + arm_agreement_bonus + rerank_gap_bonus;
  const confidence = Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, raw_total));

  return {
    confidence,
    signals: {
      base,
      pool_cleanness_bonus,
      arm_agreement_bonus,
      rerank_gap_bonus,
      raw_total,
    },
  };
}
