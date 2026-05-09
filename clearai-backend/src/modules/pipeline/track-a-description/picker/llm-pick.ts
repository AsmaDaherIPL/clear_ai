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

  const llmResult: LlmCallResult = await callLlmWithRetry({
    system,
    user,
    ...(params.model ? { model: params.model } : {}),
    maxTokens: 768,
    temperature: 0,
  });

  const isEmptyOk = llmResult.status === 'ok' && !llmResult.text;
  if (llmResult.status !== 'ok' || isEmptyOk) {
    return {
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
  }

  const text = llmResult.text!;
  const extract = extractJson(text, ParsedClassifierSchema);
  if (!extract.ok) {
    return {
      llmStatus: 'ok',
      llmModel: llmResult.model,
      latencyMs: llmResult.latencyMs,
      parseFailed: true,
      verdicts: [],
      missingAttributes: [],
      rawText: llmResult.text,
    };
  }

  const parsed = extract.data;
  const validCodes = new Set(params.candidates.map((c) => c.code));

  const rawVerdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  const verdicts: CandidateVerdict[] = rawVerdicts
    .filter(
      (v): v is { code: string; fit: string; rationale: string } =>
        v != null &&
        typeof v === 'object' &&
        typeof v.code === 'string' &&
        typeof v.fit === 'string' &&
        typeof v.rationale === 'string' &&
        validCodes.has(v.code) &&
        FIT_VALUES.has(v.fit as CandidateFitVerdict),
    )
    .map((v) => ({
      code: v.code,
      fit: v.fit as CandidateFitVerdict,
      rationale: v.rationale.slice(0, 200),
    }));

  const missingRaw = Array.isArray(parsed.missing_attributes) ? parsed.missing_attributes : [];
  const missingAttributes = missingRaw.filter(
    (x): x is MissingAttribute => typeof x === 'string' && MISSING_ENUM.has(x as MissingAttribute),
  );

  return {
    llmStatus: 'ok',
    llmModel: llmResult.model,
    latencyMs: llmResult.latencyMs,
    parseFailed: false,
    verdicts,
    missingAttributes,
    rawText: llmResult.text,
  };
}

// Re-export buildUser so track-b expand path can continue using it if needed.
export { buildUser as buildPickerUser };
