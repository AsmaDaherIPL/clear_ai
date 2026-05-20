/**
 * JSON extraction from LLM responses, validated against a Zod schema.
 * Tolerates code fences and surrounding prose. Returns a tagged result.
 */
import { z } from 'zod';

export type JsonExtractResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'no_json' | 'parse_error' | 'schema_invalid'; rawText: string };

/**
 * Locate the first complete top-level JSON object in `text`. Returns
 * the slice as a string, or null if none exists.
 *
 * Walks the text once, tracking string state (with backslash-escape
 * awareness) and brace depth. Returns as soon as a balanced object
 * closes. This is robust to braces inside prose AFTER the object
 * (e.g. Sonnet's rationale containing `{some_token}`) and to braces
 * inside string values (e.g. `"description": "size {L}"`).
 *
 * Previously the function used `indexOf('{')` + `lastIndexOf('}')`,
 * which silently corrupted any response whose prose contained a brace
 * — affecting picker, identify, sanity, every structured LLM call.
 * Failure was invisible: JSON.parse threw on a span that included the
 * prose, and the result was tagged `parse_error` with no trace of why.
 */
function findFirstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Extract the outer JSON object and validate against the schema. */
export function extractJson<T extends z.ZodTypeAny>(
  text: string,
  schema: T,
): JsonExtractResult<z.infer<T>> {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1]! : text;
  const slice = findFirstBalancedObject(body);
  if (slice === null) {
    return { ok: false, reason: 'no_json', rawText: text };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(slice);
  } catch {
    return { ok: false, reason: 'parse_error', rawText: text };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'schema_invalid', rawText: text };
  }
  return { ok: true, data: parsed.data as z.infer<T> };
}
