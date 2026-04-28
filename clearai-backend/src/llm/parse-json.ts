/**
 * Defensive JSON extraction from LLM responses, with optional Zod validation.
 *
 * LLMs return JSON in varied wrappers: bare object, fenced ```json blocks,
 * fenced unmarked ``` blocks, JSON preceded by an apologetic preamble, etc.
 * This helper is the single canonical place to deal with that variance.
 *
 * Why a single helper rather than a per-module function (the V2 pattern):
 *   - Five modules duplicated this logic with subtle drift between copies.
 *   - Centralising it means a fix to JSON parsing helps every caller.
 *   - Zod validation is an upgrade — previously each caller did `as ParsedJson`
 *     which only checked structural type at compile time, not runtime. Zod
 *     catches "model returned a number where we expected a string" before
 *     the bad value propagates.
 *
 * Returns a tagged union so callers can branch on the failure cause when
 * useful (some modules treat parse_error and schema_invalid the same;
 * others care about the distinction for observability). Failures never
 * throw — LLM output noise is a normal operating condition, not an
 * exceptional one.
 */
import { z } from 'zod';

export type JsonExtractResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'no_json' | 'parse_error' | 'schema_invalid'; rawText: string };

/**
 * Pull the first JSON object literal out of `text` and validate it against
 * the supplied Zod schema. Tolerates ```json fences, plain ``` fences,
 * leading prose, trailing prose, and whitespace.
 *
 * The extractor finds the first `{` and the last `}` (after stripping any
 * fence wrapper) — so a single trailing string of prose after the JSON is
 * fine, but a model that returns two distinct JSON objects in one response
 * will be parsed as one big object covering both. That's almost always a
 * model misbehaviour worth surfacing as `parse_error` rather than silently
 * picking one.
 */
export function extractJson<T extends z.ZodTypeAny>(
  text: string,
  schema: T,
): JsonExtractResult<z.infer<T>> {
  // 1. Strip a fence wrapper if present. Both ```json and bare ``` are accepted.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1]! : text;

  // 2. Locate the outer object braces. lastIndexOf so trailing prose doesn't
  //    cut into the JSON.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    return { ok: false, reason: 'no_json', rawText: text };
  }

  // 3. Parse.
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { ok: false, reason: 'parse_error', rawText: text };
  }

  // 4. Validate against schema.
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'schema_invalid', rawText: text };
  }
  return { ok: true, data: parsed.data as z.infer<T> };
}

/**
 * Convenience: extract without schema validation. Returns the parsed object
 * cast to the caller's type. Use this only for migration purposes — new
 * code should always supply a schema.
 *
 * @deprecated Prefer {@link extractJson} with a Zod schema for runtime safety.
 */
export function extractJsonUnsafe<T = unknown>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
