/**
 * PII redaction for request bodies persisted on classification_events.
 *
 * The recorder calls redactRequestBody() before INSERT. Only the
 * redacted form is stored — the raw request is not retained at the row
 * level. If forensic replay needs the raw request, the dispatch can be
 * re-run with the redacted shape (every field except phone/email/long-id/
 * URL is preserved verbatim, so descriptions, codes, currencies, and
 * values round-trip correctly).
 *
 * What we redact:
 *   - Phone numbers (Saudi/Gulf E.164 + locally formatted variants).
 *     Regex: leading + or 00, country code 1-3 digits, then 6-12 digits.
 *     Also catches plain 9-12 digit runs that begin with 0.
 *   - Email addresses (RFC-5322 simplified).
 *   - Long all-digit runs that look like national IDs (10+ digits,
 *     not part of an HS code — those are 4-12).
 *   - URLs (http/https) — not strictly PII but they leak external
 *     references and pollute analytics.
 *
 * What we deliberately do NOT redact:
 *   - Person names. Heuristically detecting names is unreliable and
 *     produces enormous false-positive rates on Arabic merchant text.
 *     Future enhancement: a lightweight NER pass via a local model.
 *   - HS codes. Those ARE the data we're trying to retain.
 *   - Common product nouns even when capitalised.
 *
 * Output shape:
 *   For string values, replaced runs are wrapped in `[REDACTED:<kind>]`
 *   markers — e.g. `[REDACTED:phone]`, `[REDACTED:email]`. The shape of
 *   the JSON is preserved (objects stay objects, arrays stay arrays);
 *   only string leaves are scrubbed. This means downstream consumers of
 *   `request_redacted` can do `obj.description` exactly as they did
 *   `request.description` today.
 *
 * Tests live in tests/observability/redact.test.ts.
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

interface RedactionRule {
  pattern: RegExp;
  /** Marker label, e.g. 'phone'. */
  kind: string;
}

const RULES: readonly RedactionRule[] = [
  // Email — simplified RFC 5322. Excludes the `..` and quoted-local-part edge
  // cases by design (we'd rather over-redact than miss).
  {
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    kind: 'email',
  },

  // International phone (E.164-ish): + or 00, then 6-15 digits with
  // optional spaces, dashes, parens. We require >= 8 digits total to
  // avoid false positives on dimensions like "(12 x 34)".
  {
    pattern: /(?:\+|\b00)[\d\s\-().]{6,18}\d/g,
    kind: 'phone',
  },

  // Saudi/Gulf local phone (starts with 0, 9-12 digits total).
  {
    pattern: /\b0\d[\d\s\-]{6,11}\d\b/g,
    kind: 'phone',
  },

  // National ID-shaped: a run of 10-15 digits NOT preceded by an HS
  // code-shaped context. Approximated with negative lookbehind on
  // "code" / "hs" tokens. Loose — we'd rather catch these.
  {
    pattern: /(?<!\b(?:code|hs|HS|HSCode|hscode|tariff)\s*[:=]?\s*)\b\d{10,15}\b/g,
    kind: 'id',
  },

  // URLs.
  {
    pattern: /\bhttps?:\/\/[^\s)>"']+/g,
    kind: 'url',
  },
];

// ---------------------------------------------------------------------------
// String redactor
// ---------------------------------------------------------------------------

/**
 * Apply every rule in order, replacing matches with their marker.
 * Public for unit testing; routes go via redactJsonValue / redactRequestBody.
 */
export function redactString(input: string): string {
  if (input.length === 0) return input;
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, `[REDACTED:${rule.kind}]`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recursive JSON redactor
// ---------------------------------------------------------------------------

/**
 * Walk a JSON-shaped value and redact every string leaf. Preserves the
 * structure (object keys are unchanged; arrays keep their shape; numbers,
 * booleans, nulls pass through).
 *
 * Cycle protection: we don't expect cycles in JSON-from-JSON.parse, but a
 * caller could pass a hand-built object with a self-reference. We use a
 * WeakSet to short-circuit cycles into the marker `[REDACTED:cycle]` rather
 * than stack-overflow.
 */
export function redactJsonValue(value: unknown): unknown {
  return redactInner(value, new WeakSet());
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[REDACTED:cycle]';
    seen.add(value);
    return value.map((v) => redactInner(v, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[REDACTED:cycle]';
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactInner(v, seen);
    }
    return out;
  }

  // Functions, symbols, etc. — shouldn't appear in request bodies but
  // pass through as null so JSON.stringify works.
  return null;
}

// ---------------------------------------------------------------------------
// Convenience for routes / logEvent
// ---------------------------------------------------------------------------

/**
 * Redact a request body for storage in `request_redacted`. Identical shape
 * to the input (so downstream consumers can use the same key paths).
 *
 * Returns null when input is null/undefined — the column stays NULL on
 * the row. Consumers should treat null as "redaction not attempted",
 * which today only happens via `logEvent` paths that explicitly pass
 * null (e.g. server-error fallback in error-handler.ts).
 */
export function redactRequestBody(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  return redactJsonValue(body);
}
