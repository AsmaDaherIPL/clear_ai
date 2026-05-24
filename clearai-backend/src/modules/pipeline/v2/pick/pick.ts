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
 * Confidence ceiling when merchant chapter disagrees AND picker chose a
 * non-merchant arm (added 2026-05-19, PR3 / TASKS S2 #16).
 *
 * Today's chapter_disagreement penalty (-0.10) is too weak: a clean pool
 * can still push the winner to 0.65+ even when identify and merchant
 * disagree on chapter. Hard-cap the confidence at 0.55 in that case so
 * the row routes to HITL automatically via the < 0.60 threshold.
 *
 * Applies only when picked_from_arm !== 'merchant_prefix' — if the
 * picker chose merchant's chapter, the disagreement was resolved in
 * merchant's favor and the high confidence is honest.
 */
const DISAGREEMENT_NON_MERCHANT_CONFIDENCE_CAP = 0.55;

/**
 * Identify-confidence chaining ceiling (added 2026-05-19, TASKS S2 #6).
 *
 * The picker's confidence is computed from POOL signals (verdict mix,
 * rerank gap, arm agreement). A clean pool can produce a high
 * confidence even when the upstream `identify` was a weak guess —
 * e.g. brand-only rescue at identify.confidence = 0.42 followed by a
 * clean pool that scored the winner at 0.75. The composite score
 * masks the weakest upstream link.
 *
 * Fix: when identify is clean_product with low confidence, clamp the
 * picker's confidence to `identify.confidence + OFFSET`. The chain
 * reflects "we're only as sure as our weakest stage was."
 *
 * OFFSET = 0.10 lets the picker bump a 0.42 identify up to 0.52 max
 * (still in the HITL band), instead of riding to 0.75 on pool quality
 * alone.
 *
 * Skipped when identify is `uninformative` or `multi_product` (no
 * confidence number to chain), and when identify.confidence >= 0.75
 * (already strong enough that the chain doesn't bind).
 */
const IDENTIFY_CONF_CEILING_OFFSET = 0.10;
const IDENTIFY_CONF_CHAIN_THRESHOLD = 0.75;

/**
 * Maximum length of an annotated_candidates rationale on the wire. The
 * picker prompt is told to write a short reason, but a chatty response
 * can blow up the payload — especially on 8-candidate prompts where 8 ×
 * unbounded strings could add 10-20KB. Truncating at 300 chars is the
 * same convention sanity / submission use. The full rationale stays in
 * the picker LLM call logs.
 */
const ANNOTATED_RATIONALE_MAX = 300;

/**
 * Per-fit plausibility weights used when constructing the probability
 * distribution for entropy-based confidence (PR9, 2026-05-20). Each
 * candidate's contribution to the distribution is `rerank_score *
 * fit_weight`, normalised across the pool.
 *
 * Why these values:
 *   fits=1.0          — full weight; the picker said this leaf covers the input.
 *   partial=0.5       — half weight; right family, missing dimension.
 *   does_not_fit=0.10 — small but non-zero; even a clear reject carries some
 *                      retrieval signal (it survived rerank). Zero would
 *                      collapse the distribution and inflate confidence.
 *
 * Calibrated against today's 10-row pilot (item #1 thermos): a clean
 * pool (1 fits + 2 partial + 5 does_not_fit) produces a peaked
 * distribution → high band. A 4-way tie produces a near-uniform
 * distribution → low band.
 */
const FIT_WEIGHT_FITS = 1.0;
const FIT_WEIGHT_PARTIAL = 0.5;
const FIT_WEIGHT_DOES_NOT_FIT = 0.10;

/**
 * Banding thresholds for confidence (PR9, 2026-05-20).
 *
 * The raw entropy confidence is in [0, 1]; we band it to a categorical
 * label for the SPA, so reviewers compare classifications by label
 * (High/Moderate/Fair/Low) rather than chasing decimal differences.
 *
 * Rationale for the cutpoints (mirrors Zonos's published bands):
 *   >= 0.75  → "high"     — distribution is sharply peaked on the winner
 *   >= 0.50  → "moderate" — peaked but with real competitors
 *   >= 0.25  → "fair"     — multiple plausible answers, winner just edges out
 *   >= 0.10  → "low"      — near-uniform distribution; system is mostly guessing
 *   < 0.10   → "no_result" (escalate to ZERO_SIGNAL — already done elsewhere)
 *
 * These are NOT calibrated to accuracy percentages. They are useful for
 * comparison and triage, not as literal probability statements. See
 * deriveConfidenceBand below.
 */
export type ConfidenceBand = 'high' | 'moderate' | 'fair' | 'low' | 'no_result';

const BAND_THRESHOLD_HIGH = 0.75;
const BAND_THRESHOLD_MODERATE = 0.50;
const BAND_THRESHOLD_FAIR = 0.25;
const BAND_THRESHOLD_LOW = 0.10;

/**
 * Derive the categorical band from a numeric confidence.
 *
 * PR14 (2026-05-20): the `acceptedContext` flag controls the floor.
 * `no_result` is reserved for escalate paths (no code shipped). When
 * the picker accepted a code AND that code is shipping in XML — even
 * if confidence is very low — the band should never be `no_result`,
 * because the SPA reads that as "no classification at all." The
 * floor clamps to `low` instead. Today's example: row picking
 * 620500000000 (heading-level cotton shirt) with entropy 0.05 was
 * labeled `no_result` even though the code shipped and verifier
 * correctly flagged UNCERTAIN. PR14 makes that row show `low`,
 * which matches reality.
 *
 * Per-candidate calls (annotated candidates) keep the original floor
 * — `no_result` on a loser candidate accurately tells the reviewer
 * "this candidate is essentially nothing" and doesn't conflict with
 * the winner's status.
 */
export function deriveConfidenceBand(
  confidence: number,
  acceptedContext: boolean = false,
): ConfidenceBand {
  if (confidence >= BAND_THRESHOLD_HIGH) return 'high';
  if (confidence >= BAND_THRESHOLD_MODERATE) return 'moderate';
  if (confidence >= BAND_THRESHOLD_FAIR) return 'fair';
  if (confidence >= BAND_THRESHOLD_LOW) return 'low';
  if (acceptedContext) return 'low';
  return 'no_result';
}

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
  /**
   * Structured GIR cite emitted by the picker LLM. Format: `GIR <1-6>` or
   * `GIR <1-6>(<a|b|c>)`. Added 2026-05-19 (TASKS L5) — previously we
   * regex-scraped this from rationale prose, which missed natural variants
   * like "GIR-3b", "General Interpretive Rule 3(b)". The prompt now asks
   * the model to emit a dedicated `gir` field per verdict; the regex
   * fallback stays as a defensive backstop for older model outputs.
   */
  gir?: string;
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
  /**
   * Raw input description (verbatim merchant text). PR11 (2026-05-20)
   * uses this to detect "bare-noun" inputs — single generic nouns like
   * "Trimmer", "Bracelet", "playmat" — and fire `audit_flag` when the
   * picker's verdict is not `fits`. Optional so existing tests don't
   * have to populate it; when null the bare-noun gate is a no-op.
   */
  raw_description?: string | null;
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

/**
 * Normalise a model-emitted `gir` string into the canonical
 * `GIR N` or `GIR N(a|b|c)` shape. Accepts everything the regex
 * fallback accepts, plus simple variants like "3(b)" or "3b". Returns
 * `null` on unparseable input — caller falls back to the rationale-text
 * regex if model didn't emit the field.
 */
function normaliseGir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/(?:GIR\s*)?([1-6])\s*\(?\s*([abc])?\s*\)?/i);
  if (!m) return null;
  const digit = m[1];
  const letter = m[2];
  return letter ? `GIR ${digit}(${letter.toLowerCase()})` : `GIR ${digit}`;
}

function coerceVerdict(raw: unknown, allowedCodes: Set<string>): ParsedVerdict | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const code = typeof obj.code === 'string' ? obj.code : null;
  const fit = obj.fit;
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : '';
  if (code === null || !allowedCodes.has(code)) return null;
  if (fit !== 'fits' && fit !== 'partial' && fit !== 'does_not_fit') return null;
  const girFromField = normaliseGir(obj.gir);
  return girFromField !== null
    ? { code, fit, rationale, gir: girFromField }
    : { code, fit, rationale };
}

function parseVerdicts(text: string, allowedCodes: Set<string>): ParsedVerdict[] | null {
  const extracted = extractJson(text, PickOutputSchema);
  if (!extracted.ok) return null;
  const raw = (extracted.data as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(raw)) return null;
  // Dedupe by code with last-write-wins semantics. The picker LLM is
  // instructed to verdict each candidate exactly once, but Sonnet
  // occasionally emits the same code twice; double-counting would inflate
  // tallyPopulation and falsely fire POOL_DOMINATED_BONUS. We keep the
  // last verdict for a given code (matches `Map.set` ordering when the
  // model self-corrects mid-output).
  const byCode = new Map<string, ParsedVerdict>();
  for (const v of raw) {
    const parsed = coerceVerdict(v, allowedCodes);
    if (parsed !== null) byCode.set(parsed.code, parsed);
  }
  return Array.from(byCode.values());
}

/**
 * Pick the highest-confidence positive verdict.
 *
 * Tie-break: when multiple verdicts share the same fit class (e.g. two
 * `fits`), choose the candidate with the highest `rerank_score`. Without
 * this, the winner was whichever code Sonnet happened to emit first —
 * non-reproducible across runs of identical input. The rerank_score is
 * computed deterministically upstream, so winners are now stable.
 *
 * If two candidates share both fit and rerank_score, fall back to
 * lexicographic order on code so the result is fully deterministic.
 */
function topPositive(
  verdicts: ParsedVerdict[],
  candidates: ReadonlyArray<RerankedCandidate>,
): PositiveVerdict | null {
  const rerankByCode = new Map<string, number>();
  for (const c of candidates) rerankByCode.set(c.code, c.rerank_score);
  const scoreOf = (v: ParsedVerdict): number => rerankByCode.get(v.code) ?? -Infinity;
  const bestOf = (fit: 'fits' | 'partial'): PositiveVerdict | null => {
    let best: ParsedVerdict | null = null;
    let bestScore = -Infinity;
    for (const v of verdicts) {
      if (v.fit !== fit) continue;
      const s = scoreOf(v);
      if (
        best === null ||
        s > bestScore ||
        (s === bestScore && v.code.localeCompare(best.code) < 0)
      ) {
        best = v;
        bestScore = s;
      }
    }
    return best === null ? null : { code: best.code, fit, rationale: best.rationale };
  };
  return bestOf('fits') ?? bestOf('partial');
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
 * English stopwords stripped before counting significant tokens in
 * `detectBareNounRisk`. List is deliberately short — only the words
 * that obviously add no tariff signal. Customs descriptions are
 * already terse, so we don't need a heavyweight NLP stoplist.
 */
const BARE_NOUN_STOPWORDS = new Set([
  'a', 'an', 'the',
  'for', 'with', 'of', 'in', 'on', 'and', 'or', 'to',
  'made', 'from', 'by', 'per',
  // Arabic — fewer common stopwords; "ل", "في", "من", "على" are short
  // enough that the length filter below catches them anyway.
]);

/**
 * Units stripped before counting (case-insensitive). Adding a unit
 * doesn't make a description tariff-meaningful — "500 ml" is still
 * a quantity, not a product anchor.
 */
const BARE_NOUN_UNITS = new Set([
  'ml', 'l', 'kg', 'g', 'mg', 'lb', 'oz',
  'cm', 'mm', 'm', 'inch', 'inches', 'in',
  'pcs', 'pc', 'pack', 'set', 'units', 'unit',
  'sar', 'usd', 'eur', 'aed',
  'pair', 'pairs',
]);

/**
 * Bare-noun risk detector (PR11, 2026-05-20, TASKS S2 #13).
 *
 * Returns true when the raw input description carries fewer than 3
 * significant tokens — i.e. the merchant gave us essentially a single
 * generic noun ("Trimmer", "Bracelet", "هودي فضفاض"). Retrieval can
 * find candidates for these, but the picker's resulting `fit` verdict
 * is unreliable: a "Trimmer" can be chapter 82 (manual cutting tools),
 * chapter 84 (machine tools), chapter 85 (hair clippers), or chapter
 * 96 (clipper-style trimmers). The lexical signal is too thin to
 * disambiguate without a brand, material, or model.
 *
 * Combined with `pick.fit !== 'fits'` at the call site, this becomes
 * the audit signal: "thin input + uncertain picker → review."
 *
 * Tokenisation rules:
 *   - Lowercase ASCII portions (Arabic preserved)
 *   - Strip punctuation, parens, slashes, dashes
 *   - Drop purely numeric tokens (quantities, SKUs)
 *   - Drop alphanumeric tokens that look like SKU codes (>=8 chars,
 *     mixed letters+digits, no vowels e.g. "B0F3PQHWTZ")
 *   - Drop units ("ml", "kg", "pcs", "SAR", etc.)
 *   - Drop stopwords ("for", "with", "the")
 *   - Drop tokens of length 1 (mostly punctuation noise)
 *
 * Returns false when raw_description is null/empty (gate inert).
 */
export function detectBareNounRisk(raw_description: string | null): {
  is_bare_noun: boolean;
  significant_token_count: number;
} {
  if (raw_description === null || raw_description.trim().length === 0) {
    return { is_bare_noun: false, significant_token_count: 0 };
  }
  const normalized = raw_description
    .replace(/[(),./\\\-|+:;'"`*?!]/g, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
  const rawTokens = normalized.split(' ').filter((t) => t.length > 1);
  let significant = 0;
  for (const t of rawTokens) {
    const lower = t.toLowerCase();
    if (BARE_NOUN_STOPWORDS.has(lower)) continue;
    if (BARE_NOUN_UNITS.has(lower)) continue;
    // Purely numeric (quantity, year, etc.).
    if (/^\d+(\.\d+)?$/.test(t)) continue;
    // SKU-shaped: >=8 chars, mixed alnum, no English vowels — likely
    // a model number / ASIN / barcode rather than a tariff signal.
    if (t.length >= 8 && /\d/.test(t) && /[a-z]/i.test(t) && !/[aeiou]/i.test(t)) {
      continue;
    }
    significant += 1;
  }
  return {
    is_bare_noun: significant < 3,
    significant_token_count: significant,
  };
}

/**
 * Subset-contradiction detector (PR10, 2026-05-20, TASKS S2 #3 / L6).
 *
 * The picker's prompt rule 4 says:
 *   - `does_not_fit` = wrong chapter/heading
 *   - `partial`      = wrong subheading
 *
 * So a `does_not_fit` verdict on a candidate whose chapter matches
 * identify's or merchant's chapter is a self-contradiction by the
 * prompt's own rules. The picker should have emitted `partial`. When
 * this happens, the candidate set may contain a legitimate alternative
 * the picker mis-classified as "wrong family entirely" — worth a HITL
 * look, even when the winner's verdict looks clean on its own.
 *
 * Returns true when at least one `does_not_fit` verdict matches the
 * identify chapter or the merchant chapter (excluding the winner's
 * code, which got a different verdict, and excluding any candidate
 * whose chapter equals the picker's own chosen chapter — those are
 * sibling-comparisons the picker already evaluated explicitly).
 */
function detectSubsetContradiction(input: {
  verdicts: ParsedVerdict[];
  pickedCode: string;
  pickedChapter: string;
  identifyChapter: string | null;
  merchantChapter: string | null;
}): boolean {
  const { verdicts, pickedCode, pickedChapter, identifyChapter, merchantChapter } = input;
  if (identifyChapter === null && merchantChapter === null) return false;
  for (const v of verdicts) {
    if (v.fit !== 'does_not_fit') continue;
    if (v.code === pickedCode) continue;
    const ch = v.code.slice(0, 2);
    if (ch === pickedChapter) continue; // siblings of the winner — fine
    if (ch === identifyChapter || ch === merchantChapter) {
      return true;
    }
  }
  return false;
}

/**
 * Decompose the chapter-agreement signal into 4 pairwise booleans
 * (added 2026-05-19, PR3 / TASKS S2 #16). NULL when an input is missing
 * — collapses pairs that can't be computed.
 */
function computeChapterMatches(input: {
  identify_chapter: string | null;
  merchant_chapter: string | null;
  pick_chapter: string;
}): {
  identify_and_pick: boolean | null;
  merchant_and_pick: boolean | null;
  identify_and_merchant: boolean | null;
  all_three: boolean | null;
} {
  const ip =
    input.identify_chapter !== null
      ? input.identify_chapter === input.pick_chapter
      : null;
  const mp =
    input.merchant_chapter !== null
      ? input.merchant_chapter === input.pick_chapter
      : null;
  const im =
    input.identify_chapter !== null && input.merchant_chapter !== null
      ? input.identify_chapter === input.merchant_chapter
      : null;
  const all =
    ip !== null && mp !== null && im !== null ? ip && mp && im : null;
  return {
    identify_and_pick: ip,
    merchant_and_pick: mp,
    identify_and_merchant: im,
    all_three: all,
  };
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
  identify_confidence?: number,
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
    //
    // Identify-conf chaining (2026-05-19) applies to losers too — if
    // identify was weak, the loser's "what-if confidence" is also
    // capped, so a 0.42-identify row doesn't show "alt1 at 0.65" when
    // the upstream signal didn't warrant it.
    // PR9 (2026-05-20): pass candidate_under_eval so each annotated row
    // gets its share of the entropy distribution (p_i), not the same
    // pool-wide number. The result is a real continuous score that
    // differentiates losers — e.g. on the thermos row, the closest
    // does_not_fit lands at 0.18 while the most-distant lands at 0.04,
    // instead of all does_not_fit collapsing to the legacy 0.15.
    const { confidence } = computeConfidence({
      fit: v.fit,
      verdict_population,
      candidates,
      merchant_chapter_disagreement,
      identify_confidence,
      candidate_under_eval: c,
      verdicts, // PR16: per-candidate fit weights
    });
    annotated.push({
      code: v.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      path_en: c.path_en,
      path_ar: c.path_ar,
      fit: v.fit,
      confidence,
      confidence_band: deriveConfidenceBand(confidence),
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
        maxTokens: 600,
        temperature: 0,
        timeoutMs: params.timeoutMs,
      },
      1,
    );
    lastLlm = llm;
    // Real transport failures escalate immediately — no point retrying
    // a 5xx/timeout under the parse-retry budget.
    if (llm.status !== 'ok') {
      return { llm, verdicts: null };
    }
    // 2026-05-19 (TASKS PICK-EMPTY-RETRY): Foundry occasionally returns
    // 200 OK with empty/null text body. Pilot row 126 ("Bcleen") escalated
    // as `picker_unavailable` with `detail: "picker transport ok: (no
    // error string)"` because of this. Treat ok-but-empty as a parse-retry-
    // eligible failure rather than a hard transport escalate.
    if (llm.text === null || llm.text.length === 0) {
      attempt += 1;
      continue;
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
  const top = topPositive(verdicts, candidates);
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
        /* identify_confidence */ identify.kind === 'clean_product' ? identify.confidence : undefined,
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
  // Audit flag fires for three reasons:
  //
  //  1. Chapter disagreement (any winner). PR3 / TASKS S2 #16:
  //     previously this only fired when picked_from_arm !== merchant_prefix,
  //     so a merchant-arm pick that disagreed with identify's chapter was
  //     silently accepted. Now it fires whenever merchant chapter and
  //     pick chapter differ, regardless of arm — reviewers always see
  //     the disagreement in the trace.
  //  2. CONTRADICTION (2026-05-19, TASKS S2 #4 / L1 follow-up):
  //     two or more candidates verdicted as `fits`. The PR-6 conflict
  //     mapping (feedback_pr6_conflict_type_outcomes.md) says
  //     CONTRADICTION = accept + audit_flag.
  //  3. Subset-contradiction (PR10, 2026-05-20, TASKS S2 #3 / L6):
  //     the picker's prompt rule 4 says "wrong chapter/heading =
  //     does_not_fit; wrong subheading = partial." A `does_not_fit`
  //     verdict on a candidate whose chapter matches identify's or
  //     merchant's chapter is a rule-4 violation — the picker should
  //     have emitted `partial` (right family, wrong leaf) rather than
  //     `does_not_fit` (wrong family entirely). When this happens, the
  //     candidate set may contain a partial that should have been
  //     considered; flag for HITL even when the winner looks fine.
  //
  //     Excluded from the check: candidates whose code IS the winner
  //     (they got a different verdict obviously) and candidates whose
  //     chapter equals the picked chapter (the picker already evaluated
  //     siblings).
  //  4. Bare-noun risk (PR11, 2026-05-20, TASKS S2 #13):
  //     the raw input description carries fewer than 3 significant
  //     tokens (e.g. "Trimmer", "Bracelet", "هودي فضفاض") AND the
  //     picker's verdict is not `fits`. Thin lexical signal + uncertain
  //     picker → cannot disambiguate reliably; route to HITL.
  //     Excluded from this gate: clean `fits` verdicts on bare nouns
  //     (the picker found a confident match; trust it).
  //  5. (future) identity-tokens absent from leaf path — Open task #8.
  const contradictionFlag = verdict_population.fits >= 2;
  const identifyChapter =
    identify.kind === 'clean_product' ? identify.family_chapter : null;
  const subsetContradictionFlag = detectSubsetContradiction({
    verdicts,
    pickedCode: top.code,
    pickedChapter,
    identifyChapter,
    merchantChapter: merchant_chapter,
  });
  const bareNounRisk = detectBareNounRisk(input.raw_description ?? null);
  const bareNounFlag = bareNounRisk.is_bare_noun && top.fit !== 'fits';
  const auditFlag =
    merchantChapterDisagreement ||
    contradictionFlag ||
    subsetContradictionFlag ||
    bareNounFlag;

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
        identify_confidence:
          identify.kind === 'clean_product' ? identify.confidence : undefined,
        picked_from_arm: pickedArm,
        verdicts, // PR16: per-candidate fit weights
      });
  const accepted: PickAccepted = {
    kind: 'accepted',
    final_code: top.code,
    fit: top.fit,
    confidence,
    confidence_band: deriveConfidenceBand(confidence, /* acceptedContext */ true),
    confidence_signals: signals,
    // Prefer the picker's structured `gir` field (added 2026-05-19,
    // TASKS L5). Fall back to regex-scrape of the rationale prose for
    // backward compatibility with model outputs from before the prompt
    // change shipped.
    gir_applied: top.gir ?? extractGir(top.rationale),
    verdict_population,
    picked_from_arm: pickedArm,
    merchant_chapter_disagreement: merchantChapterDisagreement,
    chapter_matches: computeChapterMatches({
      identify_chapter:
        identify.kind === 'clean_product' ? identify.family_chapter : null,
      merchant_chapter,
      pick_chapter: pickedChapter,
    }),
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
      identify.kind === 'clean_product' ? identify.confidence : undefined,
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
  /**
   * Identify-stage self-confidence (0-1). When provided and below
   * IDENTIFY_CONF_CHAIN_THRESHOLD, the final picker confidence is
   * clamped at `identify_confidence + IDENTIFY_CONF_CEILING_OFFSET`.
   * See the constant docstrings for rationale. Pass `undefined` when
   * identify did not produce a confidence (uninformative / multi_product).
   */
  identify_confidence?: number;
  /**
   * Picker's chosen arm (PR3, 2026-05-19). When merchant_chapter_
   * disagreement is true AND this is NOT 'merchant_prefix', the final
   * confidence is hard-capped at DISAGREEMENT_NON_MERCHANT_CONFIDENCE_CAP.
   * Pass undefined for per-candidate annotated calls — the cap applies
   * only to the winner.
   */
  picked_from_arm?: 'merchant_prefix' | 'family_chapter' | 'unconstrained' | 'lexical_tokens';
  /**
   * Per-candidate scoring mode (PR9, 2026-05-20). When provided, the
   * function returns this candidate's share of the entropy distribution
   * (p_i) instead of the winner's 1 - H/H_max. Used by
   * buildAnnotatedCandidates to give each annotated candidate a real
   * differential score instead of the legacy flat-bucket
   * (all does_not_fit = 0.15). Pass undefined for winner calls.
   */
  candidate_under_eval?: RerankedCandidate;
  /**
   * PR16 (2026-05-20): per-candidate verdict map. Lets the entropy
   * distribution weight each candidate by its OWN fit verdict instead
   * of a pool-wide average. Without this, a clean `{1 fit, 2 partial,
   * 5 does_not_fit}` pool with similar rerank scores produces a near-
   * uniform distribution (winner confidence ≈ 0) because the constant
   * avgFitWeight cancels in normalisation.
   *
   * Optional for backward compat with tests that pre-date PR16. When
   * absent, the function falls back to the pool-wide avgFitWeight
   * (PR9 behaviour).
   */
  verdicts?: ReadonlyArray<{ code: string; fit: 'fits' | 'partial' | 'does_not_fit' }>;
}): { confidence: number; signals: ConfidenceSignals } {
  // ------------------------------------------------------------------
  // PR9 (2026-05-20): entropy-based confidence.
  //
  // The per-fit constants + bonuses combo is kept on `ConfidenceSignals`
  // for trace audit, but the FINAL confidence is derived from the
  // entropy of the candidate-pool's probability distribution.
  //
  // Entropy framing (Zonos-inspired):
  //   distribution p_i = (rerank_score_i * fit_weight) / sum
  //   H(p)            = -sum( p_i * log p_i )      // Shannon entropy
  //   H_max           = log(N)                      // uniform distribution
  //   winner conf     = 1 - H(p) / H_max
  //
  // A sharply peaked distribution -> low entropy -> high confidence.
  // A near-uniform distribution    -> high entropy -> low confidence.
  //
  // Per-candidate calls (candidate_under_eval provided) return p_i for
  // that candidate instead, so annotated candidates carry their share
  // of the mass — no more flat bucket of 0.15 for every does_not_fit.
  // ------------------------------------------------------------------

  const candidatesWithRerank = input.candidates;
  const v = input.verdict_population;
  const totalVerdicted = v.fits + v.partial + v.does_not_fit;

  // PR16 (2026-05-20): per-candidate fit lookup. When `verdicts` is
  // supplied, each candidate's rerank_score is multiplied by ITS OWN
  // fit weight (fits=1.0, partial=0.5, does_not_fit=0.10) — so the
  // winning fitter pulls the distribution toward itself even when
  // rerank scores are clustered. Without it (PR9 behaviour), the
  // constant pool-wide avgFitWeight cancels in normalisation and the
  // distribution collapses to "whatever rerank gave us," producing
  // near-uniform shares (and near-zero entropy confidence) for any
  // pool where rerank doesn't strongly separate candidates.
  const fitByCode = new Map<string, 'fits' | 'partial' | 'does_not_fit'>();
  if (input.verdicts !== undefined) {
    for (const verd of input.verdicts) {
      fitByCode.set(verd.code, verd.fit);
    }
  }
  const fitWeightFor = (code: string): number => {
    const fit = fitByCode.get(code);
    if (fit === 'fits') return FIT_WEIGHT_FITS;
    if (fit === 'partial') return FIT_WEIGHT_PARTIAL;
    if (fit === 'does_not_fit') return FIT_WEIGHT_DOES_NOT_FIT;
    return undefined as unknown as number; // sentinel: no verdict map provided
  };

  // Fallback (PR9): pool-wide average fit weight, used when `verdicts`
  // not supplied. The average captures pool quality but cancels in
  // normalisation — kept for backward compat with tests pre-PR16.
  const totalFitWeighted =
    v.fits * FIT_WEIGHT_FITS +
    v.partial * FIT_WEIGHT_PARTIAL +
    v.does_not_fit * FIT_WEIGHT_DOES_NOT_FIT;
  const avgFitWeight =
    totalVerdicted > 0 ? totalFitWeighted / totalVerdicted : FIT_WEIGHT_PARTIAL;

  let winnerEntropyConf = CONFIDENCE_MIN;
  let perCandidateShare = CONFIDENCE_MIN;
  if (candidatesWithRerank.length > 0) {
    const weights = candidatesWithRerank.map((c) => {
      const fw = fitWeightFor(c.code);
      const effectiveWeight = Number.isFinite(fw) ? fw : avgFitWeight;
      return Math.max(0, c.rerank_score) * effectiveWeight;
    });
    const sumWeights = weights.reduce((s, w) => s + w, 0);
    if (sumWeights > 0) {
      const probs = weights.map((w) => w / sumWeights);
      // Winner entropy confidence.
      let H = 0;
      for (const p of probs) {
        if (p > 0) H -= p * Math.log(p);
      }
      const N = probs.filter((p) => p > 0).length;
      const Hmax = N > 1 ? Math.log(N) : 1;
      winnerEntropyConf = 1 - H / Hmax;
      // Per-candidate share for the input's candidate_under_eval, if any.
      if (input.candidate_under_eval !== undefined) {
        const idx = candidatesWithRerank.findIndex(
          (c) => c.code === input.candidate_under_eval!.code,
        );
        perCandidateShare = idx >= 0 ? probs[idx]! : CONFIDENCE_MIN;
      }
    }
  }

  let confidence =
    input.candidate_under_eval !== undefined ? perCandidateShare : winnerEntropyConf;

  // Legacy ConfidenceSignals — kept for trace audit. The per-fit base +
  // bonuses no longer drive `confidence`, but they remain useful as a
  // narrative of "what would the pre-PR9 formula have said?" Future
  // reviewers comparing old and new behaviour can read these directly.
  const base =
    input.fit === 'fits' ? BASE_FITS
    : input.fit === 'partial' ? BASE_PARTIAL
    : BASE_DOES_NOT_FIT;
  let pool_cleanness_bonus = 0;
  if (v.fits === 1 && v.partial === 0) {
    pool_cleanness_bonus += POOL_CLEAN_BONUS;
  }
  if (totalVerdicted > 0 && v.does_not_fit / totalVerdicted >= 0.7) {
    pool_cleanness_bonus += POOL_DOMINATED_BONUS;
  }
  const armCount = new Set(candidatesWithRerank.map((c) => c.source_arm)).size;
  let arm_agreement_bonus = 0;
  if (input.merchant_chapter_disagreement) {
    arm_agreement_bonus = ARM_DISAGREE_PENALTY;
  } else if (armCount >= 2) {
    arm_agreement_bonus = ARM_AGREE_BONUS;
  }
  let rerank_gap_bonus = 0;
  if (candidatesWithRerank.length >= 2) {
    const sorted = [...candidatesWithRerank].sort(
      (a, b) => b.rerank_score - a.rerank_score || a.code.localeCompare(b.code),
    );
    const s1 = sorted[0]!.rerank_score;
    const s2 = sorted[1]!.rerank_score;
    if (s1 > 0 && (s1 - s2) / s1 >= 0.10) {
      rerank_gap_bonus = REREK_GAP_BONUS;
    }
  }
  const raw_total = confidence; // entropy-derived final, mirrors legacy field

  confidence = Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, confidence));

  // Identify-confidence chaining: when identify was weak (e.g. brand-only
  // rescue at 0.42), cap pick.confidence so a clean candidate pool can't
  // mask the weak upstream. See IDENTIFY_CONF_CEILING_OFFSET docstring.
  if (
    input.identify_confidence !== undefined &&
    input.identify_confidence < IDENTIFY_CONF_CHAIN_THRESHOLD
  ) {
    const ceiling = input.identify_confidence + IDENTIFY_CONF_CEILING_OFFSET;
    if (confidence > ceiling) confidence = ceiling;
  }

  // Disagreement cap (PR3, 2026-05-19): when identify and merchant
  // disagree on chapter AND the picker chose a non-merchant arm, hard
  // cap at 0.55 so the row routes to HITL via the < 0.60 threshold.
  // Skips when picked_from_arm is undefined (per-candidate annotated
  // calls don't have a "winner arm" yet) or when the picker chose the
  // merchant arm (disagreement resolved in merchant's favor).
  if (
    input.merchant_chapter_disagreement &&
    input.picked_from_arm !== undefined &&
    input.picked_from_arm !== 'merchant_prefix'
  ) {
    if (confidence > DISAGREEMENT_NON_MERCHANT_CONFIDENCE_CAP) {
      confidence = DISAGREEMENT_NON_MERCHANT_CONFIDENCE_CAP;
    }
  }

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
