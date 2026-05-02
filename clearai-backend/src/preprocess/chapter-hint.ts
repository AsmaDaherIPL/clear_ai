/**
 * Chapter-hint pre-step. Cheap Haiku call that, given the cleaned product
 * description, predicts the 1-3 most likely WCO HS chapters (2-digit) so
 * the downstream retrieval can constrain its candidate pool.
 *
 * Why this exists:
 *   The 3-arm parallel retrieval pulls from the FULL 19k-row catalog. For
 *   short consumer-vocabulary inputs ("high heels", "women heals"), BM25
 *   and trigram both pull cross-chapter noise — "of high speed steel"
 *   matches "high", chickens match short-token trigrams, etc. By predicting
 *   the chapter UPFRONT and letting retrieval prefix-filter on it, we
 *   structurally eliminate the cross-chapter pollution.
 *
 * Confidence calibration:
 *   The prompt asks for a [0,1] confidence and we expose it raw — callers
 *   decide their own threshold. The convention used by the retrieval
 *   commit (#3) is:
 *     confidence ≥ HARD_FILTER_THRESHOLD (default 0.80) → prefix-filter
 *     confidence < HARD_FILTER_THRESHOLD                → no filter
 *   so a low-confidence hint degrades gracefully to today's behaviour.
 *
 * Failure mode: never throws. LLM failures degrade to "no hint" so the
 * downstream pipeline runs unconstrained, exactly as today.
 *
 * Cost / latency: ~$0.0001 per call, ~150ms wall-clock (Haiku is fast on
 * a 50-token output).
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';

export interface ChapterHintResult {
  invoked: 'llm' | 'llm_failed' | 'llm_unparseable';
  /** Empty array when confidence is too low or LLM failed — caller treats as "no hint". */
  likelyChapters: string[];
  /** [0, 1]. 0 when no hint. */
  confidence: number;
  /** One-sentence reason; empty on failure. */
  rationale: string;
  latencyMs: number;
  model?: string | undefined;
}

/**
 * Loose schema — fields validated by post-extraction code, not Zod, so the
 * LLM emitting a slightly off shape doesn't crash a degraded path.
 */
const ParsedHintSchema = z
  .object({
    likely_chapters: z.unknown().optional(),
    confidence: z.unknown().optional(),
    rationale: z.unknown().optional(),
  })
  .passthrough();

const CHAPTER_RE = /^\d{2}$/;
const VALID_CHAPTER_RE = /^(0[1-9]|[1-8]\d|9[0-7])$/;

/**
 * Coerce the LLM-emitted likely_chapters into a valid 2-digit string array.
 * Drops anything that isn't a real WCO chapter (01-97). Bounded to 3 entries.
 */
function coerceChapters(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().padStart(2, '0');
    if (!CHAPTER_RE.test(trimmed)) continue;
    if (!VALID_CHAPTER_RE.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 3) break;
  }
  return out;
}

/** Coerce confidence to a number in [0, 1]; defaults to 0 on garbage. */
function coerceConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export interface ChapterHintOpts {
  /** Default 100. */
  maxTokens?: number;
  /** Defaults to env LLM_MODEL. */
  model?: string;
}

/**
 * Predict likely HS-2 chapters for a cleaned description. Never throws.
 *
 * For empty / whitespace input, returns the empty-hint short-circuit
 * without invoking the LLM (saves ~$0.0001 + ~150ms).
 */
export async function predictChapterHint(
  cleanedDescription: string,
  opts: ChapterHintOpts = {},
): Promise<ChapterHintResult> {
  const trimmed = cleanedDescription.trim();
  if (!trimmed) {
    return {
      invoked: 'llm_failed',
      likelyChapters: [],
      confidence: 0,
      rationale: 'empty input',
      latencyMs: 0,
    };
  }

  const e = env();
  const model = opts.model ?? e.LLM_MODEL;
  const maxTokens = opts.maxTokens ?? 100;

  const outcome = await structuredLlmCall({
    promptFile: 'chapter-hint.md',
    user: `Input: ${trimmed}\n\nReturn the JSON object only.`,
    schema: ParsedHintSchema,
    stage: 'chapter_hint',
    model,
    maxTokens,
    timeoutMs: 6_000,
  });

  if (outcome.kind === 'llm_failed') {
    return {
      invoked: 'llm_failed',
      likelyChapters: [],
      confidence: 0,
      rationale: '',
      latencyMs: outcome.trace.latency_ms,
      model,
    };
  }
  if (outcome.kind !== 'ok') {
    return {
      invoked: 'llm_unparseable',
      likelyChapters: [],
      confidence: 0,
      rationale: '',
      latencyMs: outcome.trace.latency_ms,
      model,
    };
  }

  const parsed = outcome.data;
  const chapters = coerceChapters(parsed.likely_chapters);
  const confidence = coerceConfidence(parsed.confidence);
  const rationaleRaw =
    typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  // Bound rationale to 200 chars defensively.
  const rationale = rationaleRaw.slice(0, 200);

  return {
    invoked: 'llm',
    likelyChapters: chapters,
    confidence: chapters.length === 0 ? 0 : confidence,
    rationale,
    latencyMs: outcome.trace.latency_ms,
    model,
  };
}
