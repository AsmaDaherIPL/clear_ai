/**
 * Input + output sanitisers for the classification pipeline.
 *
 * Phase 2.3 of the security remediation (backend security review H6 —
 * prompt-injection surface on free-text -> LLM path). Two functions:
 *
 *   - detectInjectionShape(input): heuristic check for instruction-shaped
 *     content in user-supplied descriptions. Returns null when clean,
 *     a short reason string when it looks like a prompt-injection attempt.
 *     Used by routes/schemas.ts via Zod .refine() to reject before reaching
 *     the LLM.
 *
 *   - sanitiseRationale(text): output-side sanitiser for the picker's
 *     free-text `rationale` field. Strips control chars and HTML-shaped
 *     tokens, length-caps to 500 chars (already capped at the picker, this
 *     is defence-in-depth). Used in classify/expand routes before persist
 *     and before the response goes back to the client.
 *
 * Design notes:
 *   - Input filter is deliberately CONSERVATIVE. False positives reject a
 *     legitimate description; false negatives let an injection attempt
 *     through to the LLM. We err toward false positives because the LLM is
 *     not asked to do "literal customer support" — it classifies HS codes.
 *     A description that says "ignore all previous instructions" is almost
 *     certainly not a real product.
 *   - Output sanitiser is permissive on Unicode (ZATCA classifications
 *     legitimately use Arabic + diacritics + punctuation), but strips:
 *       * control characters (U+0000-U+001F, U+007F-U+009F)
 *       * angle-bracket-shaped tokens (script, svg, etc.) — defence
 *         against future frontends that render rationale as HTML
 *       * javascript: and data: URIs
 *   - Both functions are pure (no DB, no env). Test directly with vitest.
 */

// ---------------------------------------------------------------------------
// Input sanitiser
// ---------------------------------------------------------------------------

/**
 * Patterns that look like prompt-injection attempts.
 *
 * Each pattern includes a short label used in the rejection reason so
 * structured logs can distinguish "ignore previous" attempts from "fake
 * assistant turn" attempts. The label is deliberately bland — exposing the
 * exact regex would help an attacker iterate.
 */
const INJECTION_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  // "Ignore (the/all) (previous/prior/above) instructions/prompts/system"
  // Variations: "Disregard", "Forget", "Override".
  {
    pattern:
      /\b(ignore|disregard|forget|override)\s+(the\s+|all\s+|any\s+)?(previous|prior|above|preceding|earlier|system|original)\s+(instructions?|prompts?|messages?|rules?|directives?)\b/i,
    label: 'instruction_override',
  },

  // Fake role markers used in chat-completion injection.
  // "Assistant:", "System:", "Human:" at line start.
  {
    pattern: /^(\s*)(assistant|system|human|user)\s*:/im,
    label: 'role_marker',
  },

  // Anthropic-style fake conversation markers (escaped \n in user input).
  {
    pattern: /\\n\s*(Assistant|Human|System):/i,
    label: 'role_marker',
  },

  // <script>, javascript:, on*= — stored-XSS shapes.
  {
    pattern: /<\s*script\b/i,
    label: 'script_tag',
  },
  {
    pattern: /\bjavascript\s*:/i,
    label: 'js_uri',
  },
  {
    pattern: /\bon(error|load|click|focus|mouseover)\s*=/i,
    label: 'event_handler',
  },

  // "You are now a different AI / DAN / jailbroken / unrestricted"
  {
    pattern:
      /\byou\s+are\s+(now\s+)?(a\s+|an\s+)?(different|new|unrestricted|jailbroken|dan|developer|root|admin|godmode)\b/i,
    label: 'persona_swap',
  },

  // Tool-use spoofing. The angle-bracket variants don't have natural word
  // boundaries on the leading `<`, so we drop \b and use start/end anchors
  // appropriate to each variant.
  {
    pattern: /(\btool_use\b|\btool_result\b|<tool>|<function_call>)/i,
    label: 'tool_spoof',
  },

  // Excessive repeated newlines (used to push the model past a window of
  // context). 4+ consecutive newlines is far past anything a real product
  // description would have.
  {
    pattern: /\n{4,}/,
    label: 'newline_flood',
  },
];

export interface InjectionDetection {
  /** Short stable label, e.g. 'instruction_override'. */
  label: string;
  /** Human-readable reason for the structured log + client error. */
  reason: string;
}

/**
 * Returns null when the input passes; an InjectionDetection when it looks
 * like an injection attempt. Intended as a Zod `.refine()` body or a
 * standalone guard.
 *
 * Performance: each pattern is a small RegExp; we short-circuit on first
 * match. For our 200-char description cap this is sub-microsecond.
 */
export function detectInjectionShape(input: string): InjectionDetection | null {
  // Empty input passes; the schema's .min(1) catches it elsewhere.
  if (input.length === 0) return null;
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return {
        label,
        reason: 'description rejected: contains text shaped like a prompt-injection attempt',
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output sanitiser
// ---------------------------------------------------------------------------

// Control-char regex written with \u escapes so the source stays plain ASCII.
// Strips C0 (U+0000-U+001F) excluding \t (U+0009) and \n (U+000A), plus
// DEL (U+007F) and C1 (U+0080-U+009F).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Strip whole `<script>...</script>` pairs (and similar) including the
// element body — the body is where the actual payload lives. `[\s\S]*?` is
// non-greedy so we don't span unrelated content.
const HTML_PAIR_TAGS =
  /<\s*(script|svg|iframe|object|style|video|audio|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

// After stripping pairs, also strip any remaining tag-opener for
// dangerous self-closing or singleton tags (img, link, meta, etc.).
const HTML_SHAPED_TAGS =
  /<\s*\/?\s*(script|svg|img|iframe|embed|object|style|link|meta|base|form|input|button|video|audio|source)\b[^>]*>?/gi;

// `javascript:` URI — capture up to the next whitespace, closing quote, or
// HTML-block boundary. We intentionally include `(` and `)` characters
// so a `javascript:alert(1)` URL body is fully consumed; this risks
// over-grab on URIs surrounded by parens, but that's a minor cosmetic
// issue and the safe direction.
const JS_URI = /\bjavascript\s*:[^"'\s>]*/gi;

// `data:` URI — same approach. Must NOT include `<` (so a following HTML
// pair stays parseable for the next regex pass).
const DATA_URI = /\bdata\s*:\s*[a-z]+\/[a-z+\-]+(?:;[a-z0-9\-=]+)*,[^"'\s<]*/gi;

/**
 * Strip dangerous content from picker-emitted free text.
 *
 * Applied in two places:
 *   1. Before persisting `rationale` to classification_events.
 *   2. Before the response body that ships `rationale` back to the client.
 *
 * Both passes use this same function so persisted data == shipped data.
 *
 * Length cap: 500 chars. The picker already slices to 500 (see
 * src/classification/llm-pick.ts line 116) but defence-in-depth: a future
 * caller might bypass that.
 */
export function sanitiseRationale(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  if (text.length === 0) return null;

  let out = text;

  // 1. Strip control chars except tab/newline.
  out = out.replace(CONTROL_CHARS, '');

  // 2. Strip whole `<script>...</script>` pairs (and similar) including
  //    the element body — the body is where the actual XSS payload lives.
  out = out.replace(HTML_PAIR_TAGS, '');

  // 3. Strip any remaining tag-opener for dangerous tag names. This
  //    handles self-closing tags (<img/>, <link/>) plus orphaned closing
  //    tags left behind. Real product rationale never has angle brackets
  //    followed by alphabetic; if a future broker rationale needs `<`
  //    it'll be in math/numeric context with surrounding spaces.
  out = out.replace(HTML_SHAPED_TAGS, '');

  // 4. Strip standalone `javascript:` URIs (XSS paste vector).
  out = out.replace(JS_URI, '');

  // 5. Strip `data:` URIs (often image-shaped XSS payloads).
  out = out.replace(DATA_URI, '');

  // 6. Length cap. Truncate AFTER stripping so we don't trim mid-tag.
  if (out.length > 500) {
    out = out.slice(0, 500).trimEnd();
  }

  // 7. Whitespace tidy: collapse runs of 2+ spaces, trim. Do not collapse
  //    newlines — paragraphs in rationale are legitimate.
  out = out.replace(/[ \t]{2,}/g, ' ').trim();

  return out.length === 0 ? null : out;
}
