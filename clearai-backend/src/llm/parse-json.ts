/**
 * JSON extraction from LLM responses, validated against a Zod schema.
 *
 * Tolerates ```json fences, bare ``` fences, leading/trailing prose,
 * whitespace. Failures return tagged result instead of throwing — LLM
 * output noise is normal.
 */
import { z } from 'zod';

export type JsonExtractResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'no_json' | 'parse_error' | 'schema_invalid'; rawText: string };

/** Extract the outer JSON object and validate against the schema. */
export function extractJson<T extends z.ZodTypeAny>(
  text: string,
  schema: T,
): JsonExtractResult<z.infer<T>> {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1]! : text;
  // lastIndexOf so trailing prose doesn't cut into the JSON.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    return { ok: false, reason: 'no_json', rawText: text };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { ok: false, reason: 'parse_error', rawText: text };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'schema_invalid', rawText: text };
  }
  return { ok: true, data: parsed.data as z.infer<T> };
}

/** @deprecated Use {@link extractJson} with a Zod schema. */
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
