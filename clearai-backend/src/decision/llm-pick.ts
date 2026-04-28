/**
 * LLM picking step. Calls Foundry with the GIR system prompt + a per-endpoint
 * picker prompt. Returns a structured pick or null.
 *
 * Hallucination guard (ADR enforcement) applied here: if the chosen_code is not
 * in the candidate set, the result is reported as guard_tripped so the
 * decision-resolution layer turns it into needs_clarification.
 */
import { z } from 'zod';
import { callLlmWithRetry, type LlmCallResult } from '../llm/client.js';
import { extractJson } from '../llm/parse-json.js';
import { loadPrompt } from '../llm/structured-call.js';
import type { Candidate } from '../retrieval/retrieve.js';
import type { MissingAttribute } from './types.js';

/**
 * The picker is unique among the LLM-calling modules: its system prompt is
 * the concatenation of two files (`gir-system.md` + `picker-describe.md` or
 * `picker-expand.md`) — the GIR rules apply to both routes, but the
 * per-route prompt body differs. Other modules use the single-file
 * `structuredLlmCall` shape; the picker uses `loadPrompt` (the same shared
 * cache) twice and assembles the system prompt itself.
 */

export interface LlmPickResult {
  llmStatus: 'ok' | 'error' | 'timeout';
  llmModel: string;
  latencyMs: number;
  guardTripped: boolean;
  parseFailed: boolean;
  chosenCode: string | null;
  rationale: string | null;
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

// Loose schema — downstream code does its own type-narrowing because the
// model may emit `null` for chosen_code (legitimate "no pick") or wrap
// missing_attributes in a non-array shape on edge cases.
const ParsedPickerSchema = z
  .object({
    chosen_code: z.unknown().optional(),
    rationale: z.unknown().optional(),
    missing_attributes: z.unknown().optional(),
  })
  .passthrough();

function buildUser(query: string, candidates: Candidate[], parentPrefix?: string): string {
  const parentLine = parentPrefix ? `Declared parent prefix: ${parentPrefix}\n\n` : '';
  const lines = candidates.map(
    (c, i) =>
      `${i + 1}. code=${c.code}\n   en: ${c.description_en ?? '(none)'}\n   ar: ${c.description_ar ?? '(none)'}`
  );
  return `${parentLine}User description:\n${query}\n\nCandidates:\n${lines.join('\n')}\n\nReturn JSON only.`;
}

export async function llmPick(params: {
  kind: 'describe' | 'expand';
  query: string;
  candidates: Candidate[];
  parentPrefix?: string;
  model?: string;
}): Promise<LlmPickResult> {
  const pickerFile = params.kind === 'describe' ? 'picker-describe.md' : 'picker-expand.md';
  const [gir, picker] = await Promise.all([
    loadPrompt('gir-system.md'),
    loadPrompt(pickerFile),
  ]);
  const system = `${gir}\n\n---\n\n${picker}`;
  const user = buildUser(params.query, params.candidates, params.parentPrefix);

  const llmResult: LlmCallResult = await callLlmWithRetry({
    system,
    user,
    ...(params.model ? { model: params.model } : {}),
    maxTokens: 512,
    temperature: 0,
  });

  // Operational failure — fast path. Two cases must collapse to llmStatus='error':
  //   (a) the wire call itself failed (status='error'|'timeout'); the client already
  //       set status correctly.
  //   (b) the wire call succeeded (status='ok') but the response carried no text
  //       block (empty content[], non-text-only content, or null text). This is an
  //       *unexpected provider response shape*, not a business signal that the
  //       user input was unclear. Earlier code returned llmStatus='ok' with
  //       chosenCode=null, which resolve() then mapped to ambiguous_top_candidates,
  //       hiding the real fault from operators and giving the wrong remediation
  //       hint to callers. We escalate it to llmStatus='error' here so resolve()
  //       emits decision_status='degraded' / decision_reason='llm_unavailable'.
  const isEmptyOk = llmResult.status === 'ok' && !llmResult.text;
  if (llmResult.status !== 'ok' || isEmptyOk) {
    return {
      llmStatus: isEmptyOk ? 'error' : llmResult.status,
      llmModel: llmResult.model,
      latencyMs: llmResult.latencyMs,
      guardTripped: false,
      parseFailed: false,
      chosenCode: null,
      rationale: null,
      missingAttributes: [],
      rawText: null,
      ...(isEmptyOk
        ? { rawError: 'provider returned status=ok with no text block' }
        : llmResult.error
          ? { rawError: llmResult.error }
          : {}),
    };
  }

  // Past the early return above, llmResult.text is guaranteed to be a non-empty
  // string (status === 'ok' && !!text). Narrow with a non-null assertion
  // — the early-return guard above is logical, not control-flow analyzable
  // through a const, so TS otherwise still treats `text` as `string | null`.
  const text = llmResult.text!;
  const extract = extractJson(text, ParsedPickerSchema);
  if (!extract.ok) {
    return {
      llmStatus: 'ok',
      llmModel: llmResult.model,
      latencyMs: llmResult.latencyMs,
      guardTripped: true,
      parseFailed: true,
      chosenCode: null,
      rationale: null,
      missingAttributes: [],
      rawText: llmResult.text,
    };
  }
  const parsed = extract.data;

  const codeRaw = parsed.chosen_code;
  const chosen = typeof codeRaw === 'string' && codeRaw.length === 12 ? codeRaw : null;
  const rationale =
    typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 500) : null;

  const missingRaw = Array.isArray(parsed.missing_attributes) ? parsed.missing_attributes : [];
  const missing = missingRaw
    .filter((x): x is MissingAttribute => typeof x === 'string' && MISSING_ENUM.has(x as MissingAttribute));

  // Hallucination guard: chosen_code must appear in the candidate set.
  let guardTripped = false;
  if (chosen) {
    const inSet = params.candidates.some((c) => c.code === chosen);
    if (!inSet) guardTripped = true;
  }

  return {
    llmStatus: 'ok',
    llmModel: llmResult.model,
    latencyMs: llmResult.latencyMs,
    guardTripped,
    parseFailed: false,
    chosenCode: guardTripped ? null : chosen,
    rationale,
    missingAttributes: missing,
    rawText: llmResult.text,
  };
}
