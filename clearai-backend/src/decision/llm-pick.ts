/**
 * LLM picking step. Calls Foundry with the GIR system prompt + a per-endpoint
 * picker prompt. Returns a structured pick or null.
 *
 * Hallucination guard (ADR enforcement) applied here: if the chosen_code is not
 * in the candidate set, the result is reported as guard_tripped so the
 * decision-resolution layer turns it into needs_clarification.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callLlmWithRetry, type LlmCallResult } from '../llm/client.js';
import type { Candidate } from '../retrieval/retrieve.js';
import type { MissingAttribute } from './types.js';

const PROMPT_DIR = join(process.cwd(), 'prompts');

let _girCache: string | null = null;
async function getGirSystem(): Promise<string> {
  if (_girCache) return _girCache;
  _girCache = await readFile(join(PROMPT_DIR, 'gir-system.md'), 'utf8');
  return _girCache;
}

let _pickerDescribe: string | null = null;
let _pickerExpand: string | null = null;
async function getPicker(kind: 'describe' | 'expand'): Promise<string> {
  if (kind === 'describe') {
    if (_pickerDescribe) return _pickerDescribe;
    _pickerDescribe = await readFile(join(PROMPT_DIR, 'picker-describe.md'), 'utf8');
    return _pickerDescribe;
  }
  if (_pickerExpand) return _pickerExpand;
  _pickerExpand = await readFile(join(PROMPT_DIR, 'picker-expand.md'), 'utf8');
  return _pickerExpand;
}

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

interface ParsedJson {
  chosen_code: unknown;
  rationale: unknown;
  missing_attributes: unknown;
}

function tryExtractJson(text: string): ParsedJson | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as ParsedJson;
  } catch {
    return null;
  }
}

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
  const [gir, picker] = await Promise.all([getGirSystem(), getPicker(params.kind)]);
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
  const parsed = tryExtractJson(text);
  if (!parsed) {
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
