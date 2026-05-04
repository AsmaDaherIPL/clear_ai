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

/** Path injection mode for the picker user message. Backed by setup_meta.PICKER_PATH_MODE. */
export type PickerPathMode = 0 | 1 | 2;

/**
 * Heading title for a candidate, derived from its display path.
 *   • If the candidate's first path-codes element is its HS-4 heading
 *     (XXXX00000000 — non-self), the heading title is path_en split[0].
 *   • Otherwise (the candidate IS its own heading), the heading title is
 *     the leaf description itself.
 *   • If path data is missing entirely, returns empty string — caller treats
 *     as "no heading available" and falls back to the mode-0 emit.
 */
function headingTitleFor(c: Candidate): string {
  if (!c.path_en) return '';
  const parts = c.path_en.split(' > ');
  // path_codes[0] === self when the candidate IS the heading. In that case
  // we still want a sensible heading title — the leaf description doubles
  // as the heading title in this catalog.
  return parts[0] ?? '';
}

/** HS-4 heading code for a candidate. Always derivable from `code`. */
function headingCodeFor(c: Candidate): string {
  return c.code.slice(0, 4);
}

/**
 * Mode-2 breadcrumb for a single candidate: full path joined by " › "
 * (Unicode angle bracket — visually distinct from the regular `>` used by
 * `path_en` to avoid the model parsing them as the same separator).
 */
function breadcrumbFor(c: Candidate): string {
  if (!c.path_en) return '';
  return c.path_en.split(' > ').join(' › ');
}

/**
 * Build the picker's user message. `pathMode` controls candidate formatting:
 *
 *   mode 0 — current behaviour, code + en + ar per candidate, numbered list.
 *
 *   mode 1 — group consecutive same-heading candidates under a heading
 *            header. RRF rank order is preserved (no re-sorting); we just
 *            emit a `Heading <NNNN> — <heading title>` line whenever the
 *            heading code changes from the previous candidate. Indexes
 *            (1..N) are kept on each candidate so the model's chosen_code
 *            response shape is unaffected.
 *
 *   mode 2 — append a `path: A › B › C › leaf` line to each candidate. No
 *            grouping — each candidate gets its own breadcrumb. Higher
 *            token cost than mode 1 but maximum context.
 *
 * Defensive fallback: if a candidate has no path data (LEFT JOIN miss),
 * mode 1/2 emit it in mode-0 form for that single row rather than crashing.
 */
export function buildUser(
  query: string,
  candidates: Candidate[],
  pathMode: PickerPathMode,
  parentPrefix?: string,
): string {
  const parentLine = parentPrefix ? `Declared parent prefix: ${parentPrefix}\n\n` : '';

  const lines: string[] = [];

  if (pathMode === 0) {
    candidates.forEach((c, i) => {
      lines.push(
        `${i + 1}. code=${c.code}\n   en: ${c.description_en ?? '(none)'}\n   ar: ${c.description_ar ?? '(none)'}`,
      );
    });
  } else if (pathMode === 1) {
    let lastHeadingCode: string | null = null;
    candidates.forEach((c, i) => {
      const headingCode = headingCodeFor(c);
      const headingTitle = headingTitleFor(c);
      if (headingCode !== lastHeadingCode) {
        // Blank line between groups (skip before the very first one).
        if (lastHeadingCode !== null) lines.push('');
        if (headingTitle) {
          lines.push(`Heading ${headingCode} — ${headingTitle}`);
        } else {
          // No path data — emit a bare header so the index numbering still
          // makes sense to the reader, but skip the title.
          lines.push(`Heading ${headingCode}`);
        }
        lastHeadingCode = headingCode;
      }
      lines.push(
        `  ${i + 1}. code=${c.code}\n     en: ${c.description_en ?? '(none)'}\n     ar: ${c.description_ar ?? '(none)'}`,
      );
    });
  } else {
    // mode 2 — full breadcrumb per candidate
    candidates.forEach((c, i) => {
      const crumb = breadcrumbFor(c);
      const crumbLine = crumb ? `\n   path: ${crumb}` : '';
      lines.push(
        `${i + 1}. code=${c.code}\n   en: ${c.description_en ?? '(none)'}\n   ar: ${c.description_ar ?? '(none)'}${crumbLine}`,
      );
    });
  }

  return `${parentLine}User description:\n${query}\n\nCandidates:\n${lines.join('\n')}\n\nReturn JSON only.`;
}

export async function llmPick(params: {
  kind: 'describe' | 'expand';
  query: string;
  candidates: Candidate[];
  /** From setup_meta.PICKER_PATH_MODE. 0 = none, 1 = heading-only, 2 = full path. */
  pathMode: PickerPathMode;
  parentPrefix?: string;
  model?: string;
}): Promise<LlmPickResult> {
  const pickerFile = params.kind === 'describe' ? 'picker-describe.md' : 'picker-expand.md';
  const [gir, picker] = await Promise.all([
    loadPrompt('gir-system.md'),
    loadPrompt(pickerFile),
  ]);
  const system = `${gir}\n\n---\n\n${picker}`;
  const user = buildUser(params.query, params.candidates, params.pathMode, params.parentPrefix);

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
