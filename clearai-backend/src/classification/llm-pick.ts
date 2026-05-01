/**
 * LLM picker. System prompt is gir-system.md + picker-{describe,expand}.md.
 * Hallucination guard: chosen_code must appear in the candidate set.
 */
import { z } from 'zod';
import { callLlmWithRetry, type LlmCallResult, type LlmStatus } from '../llm/client.js';
import { extractJson } from '../llm/parse-json.js';
import { loadPrompt } from '../llm/structured-call.js';
import type { Candidate } from '../retrieval/retrieve.js';
import type { MissingAttribute } from './types.js';

export interface LlmPickResult {
  llmStatus: LlmStatus;
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

/** Loose schema — downstream code re-narrows. */
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

  // status=ok with no text block = unexpected provider shape; escalate to error.
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

  // Non-null assertion: the isEmptyOk guard above made TS see this as still nullable.
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
