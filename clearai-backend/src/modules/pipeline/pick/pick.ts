/**
 * Pick stage (anchored pipeline, stage 3 of 3).
 *
 * Single Sonnet picker call over a scope-anchored candidate set.
 * Replaces the legacy retrieval + threshold + picker chain with one
 * step that operates over a pre-narrowed pool produced by constrain's
 * scope decision.
 *
 * Contract:
 *   input:  PickInput (identify + constrain results)
 *   output: PickResult (accepted final_code OR escalate with reason)
 *   engine: retrieveCandidates(query, {prefixFilter: scope.prefix})
 *           + one Sonnet picker call with simplified 3-value fit verdict
 *
 * Every code path produces a PickCallTrace so PR-A-5's orchestrator
 * can record audit fields uniformly (matches the trace pattern
 * established by PR-A-2's identify and PR-A-3's constrain).
 */
import { z } from 'zod';
import { callLlmWithRetry, type LlmCallResult } from '../../../inference/llm/client.js';
import { loadPrompt } from '../../../inference/llm/structured-call.js';
import { extractJson } from '../../../inference/llm/parse-json.js';
import { getLlmStagePolicy } from '../../../inference/llm/policy.js';
import { env } from '../../../config/env.js';
import { retrieveCandidates, type Candidate } from '../../../inference/retrieval/retrieve.js';
import { buildUser } from '../classify/description-classifier/picker/llm-pick.js';
import type { IdentifyResult } from '../identify/identify.types.js';
import type { RetrievalScope } from '../constrain/constrain.types.js';
import type {
  PickCallTrace,
  PickInput,
  PickResult,
  VerdictPopulation,
} from './pick.types.js';

/**
 * Confidence assigned to a `fits` verdict. Exported so PR-A-5's
 * reconciliation can read the policy by symbol rather than hardcoded
 * value. Coarse scalar today; PR-A-5 may compute spread-aware
 * confidence from the verdict_population field instead.
 */
export const FITS_CONFIDENCE = 0.85;

/**
 * Confidence assigned to a `partial` verdict. Set above the typical
 * accept threshold (0.5) so the row is accepted by default — the
 * orchestrator may still escalate via audit_flag or the picker's
 * verdict_population spread.
 */
export const PARTIAL_CONFIDENCE = 0.55;

/** Number of parse-retry attempts on top of the initial picker call. */
const PARSE_RETRY_LIMIT = 2;

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

/** Build the retrieval-and-picker query from identify output. */
function buildQuery(identify: IdentifyResult): string {
  if (identify.kind === 'clean_product') {
    const tokens =
      identify.identity_tokens.length > 0 ? ` ${identify.identity_tokens.join(' ')}` : '';
    return `${identify.canonical}${tokens}`.trim();
  }
  // Uninformative / multi_product have no canonical. Callers MUST
  // check this before invoking the picker — empty-query LLM picks
  // waste budget and produce unauditable guesses. Mirrors the
  // pattern PR-A-3 established in resolve-merchant.ts.
  return '';
}

function auditFlagFromScope(scope: RetrievalScope): boolean {
  if (scope.kind === 'merchant_prefix') return scope.audit_flag;
  if (scope.kind === 'family_chapter') return scope.audit_flag;
  return false;
}

function skippedTrace(scope: RetrievalScope, latencyMs: number): PickCallTrace {
  return {
    llm_called: false,
    latency_ms: latencyMs,
    candidate_count: 0,
    status: 'skipped',
    model: null,
    audit_flag: auditFlagFromScope(scope),
  };
}

function traceFromLlm(
  scope: RetrievalScope,
  candidateCount: number,
  totalLatencyMs: number,
  llm: LlmCallResult,
  parsed: 'ok' | 'parse',
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
    audit_flag: auditFlagFromScope(scope),
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

/**
 * Parse the picker LLM response into verdicts. Returns null when the
 * response is unparseable. Drops verdicts whose `code` isn't in the
 * candidate set (LLM may hallucinate codes) and verdicts whose `fit`
 * isn't a recognised value.
 */
function parseVerdicts(text: string, allowedCodes: Set<string>): ParsedVerdict[] | null {
  const extracted = extractJson(text, PickOutputSchema);
  if (!extracted.ok) return null;
  const raw = extracted.data.verdicts;
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

function tallyPopulation(verdicts: ParsedVerdict[]): VerdictPopulation {
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

/**
 * Extract the GIR citation from a rationale string. Tolerates a few
 * common formattings the model emits ("GIR 3(a)", "GIR3(a)",
 * "GIR 3 (a)", lowercase). Returns empty string on no match.
 */
function extractGir(rationale: string): string {
  // Match "GIR" + optional whitespace + digit 1-6 + optional
  // (whitespace + parenthesized letter).
  const match = rationale.match(/GIR\s*([1-6])\s*(?:\(([abc])\))?/i);
  if (!match) return '';
  const digit = match[1];
  const letter = match[2];
  return letter ? `GIR ${digit}(${letter.toLowerCase()})` : `GIR ${digit}`;
}

function retrieveOptsFromScope(scope: RetrievalScope): { prefixFilter?: string } {
  if (scope.kind === 'merchant_prefix') return { prefixFilter: scope.prefix };
  if (scope.kind === 'family_chapter') return { prefixFilter: scope.chapter };
  return {};
}

/**
 * Call the picker LLM with a bounded parse-retry loop. The same
 * prompt + candidate set is sent on retry — the point is to ride out
 * transient model glitches, not coax different outputs. Transport-
 * level failures don't retry here (the circuit breaker handles
 * sustained failures), only parse-class failures.
 *
 * Returns the LAST attempt's result plus the parsed verdicts (or
 * null if the last attempt still wouldn't parse).
 */
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
        stage: 'anchored_pick',
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
    // Transport-class failure → don't parse-retry (the breaker is the
    // right place to handle sustained errors).
    if (llm.status !== 'ok' || llm.text === null || llm.text.length === 0) {
      return { llm, verdicts: null };
    }
    const verdicts = parseVerdicts(llm.text, params.allowedCodes);
    lastVerdicts = verdicts;
    if (verdicts !== null) return { llm, verdicts };
    attempt += 1;
  }
  // Parse-retry exhausted; return last attempt + null verdicts so
  // the caller knows to escalate as picker_unavailable / parse.
  return { llm: lastLlm!, verdicts: lastVerdicts };
}

/**
 * Public entry. Stage 3 of the anchored pipeline.
 *
 * Returns PickResult (typed union, always carries a trace). Never
 * throws on retrieval or LLM failures — those degrade to escalate
 * with a populated `reason`. Throws only on programmer error
 * (prompt file missing).
 */
export async function runPick(input: PickInput): Promise<PickResult> {
  const t0 = Date.now();
  const { identify, constrain } = input;
  const { scope } = constrain;

  // Scope is escalate → short-circuit. No retrieval, no LLM call.
  if (scope.kind === 'escalate') {
    return {
      kind: 'escalate',
      reason: 'scope_escalate',
      detail: `scope escalated: ${scope.reason}`,
      trace: skippedTrace(scope, Date.now() - t0),
    };
  }

  // Empty-query short-circuit: identify produced no description
  // signal (uninformative / multi_product). Even when the scope
  // anchors retrieval, calling the picker with no description is
  // unauditable guessing. Match the PR-A-3 pattern from
  // resolve-merchant.ts.
  const query = buildQuery(identify);
  if (query.length === 0) {
    return {
      kind: 'escalate',
      reason: 'identify_no_query',
      detail: `identify produced no description-side signal (kind=${identify.kind}); refusing picker call`,
      trace: skippedTrace(scope, Date.now() - t0),
    };
  }

  // Retrieval.
  const candidates = await retrieveCandidates(query, retrieveOptsFromScope(scope));

  if (candidates.length === 0) {
    return {
      kind: 'escalate',
      reason: 'no_candidates',
      detail: `retrieval returned 0 candidates under scope.kind=${scope.kind}`,
      trace: skippedTrace(scope, Date.now() - t0),
    };
  }

  // Picker LLM call (with bounded parse-retry).
  const policy = getLlmStagePolicy('anchored_pick');
  const system = await loadPrompt('pick-anchored.md');
  const user = buildUser(query, candidates);
  const allowedCodes = new Set(candidates.map((c: Candidate) => c.code));

  const { llm, verdicts } = await attemptPick({
    system,
    user,
    model: env().LLM_MODEL_STRONG,
    timeoutMs: policy.timeoutMs,
    allowedCodes,
  });

  // Transport-level failure.
  if (llm.status !== 'ok' || llm.text === null || llm.text.length === 0) {
    return {
      kind: 'escalate',
      reason: 'picker_unavailable',
      detail: `picker transport ${llm.status}: ${
        llm.error !== undefined && llm.error.length > 0 ? llm.error : '(transport produced no error string)'
      }`,
      trace: traceFromLlm(scope, candidates.length, Date.now() - t0, llm, 'ok'),
    };
  }

  // Parse failure after retries exhausted.
  if (verdicts === null) {
    return {
      kind: 'escalate',
      reason: 'picker_unavailable',
      detail: `picker output unparseable after ${PARSE_RETRY_LIMIT + 1} attempts`,
      trace: traceFromLlm(scope, candidates.length, Date.now() - t0, llm, 'parse'),
    };
  }

  // No positive verdict among the candidates → escalate.
  const top = topPositive(verdicts);
  const verdict_population = tallyPopulation(verdicts);
  if (top === null) {
    return {
      kind: 'escalate',
      reason: 'no_candidate_fits',
      detail: `picker returned no fits or partial verdicts (fits=${verdict_population.fits}, partial=${verdict_population.partial}, does_not_fit=${verdict_population.does_not_fit})`,
      trace: traceFromLlm(scope, candidates.length, Date.now() - t0, llm, 'ok'),
    };
  }

  return {
    kind: 'accepted',
    final_code: top.code,
    confidence: top.fit === 'fits' ? FITS_CONFIDENCE : PARTIAL_CONFIDENCE,
    gir_applied: extractGir(top.rationale),
    fit: top.fit,
    verdict_population,
    trace: traceFromLlm(scope, candidates.length, Date.now() - t0, llm, 'ok'),
  };
}
