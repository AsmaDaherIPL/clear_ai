/**
 * Digit normalization (ADR-0003).
 *
 * Free-text inputs sometimes carry digit runs ("shirt 89123"). Per-length rules:
 *   - <4 digits           → keep as text noise
 *   - 4-11, no chapter/heading match → strip silently
 *   - 4-11, matches chapter or heading → keep + soft RRF bias
 *   - exactly 12, matches a real row    → DEFERRED for v1 (treat as text noise)
 *   - >12                 → text noise
 *
 * Produces the cleaned query text plus an optional hierarchy bias.
 */

export interface DigitNormalizeResult {
  cleanedText: string;
  /** If set, retrieval should soft-bias candidates that start with this prefix. */
  prefixBias: string | null;
  /** For audit/logging. */
  detected: Array<{ run: string; action: 'kept_as_text' | 'stripped' | 'biased' | 'deferred_12' }>;
}

export interface KnownPrefixes {
  chapters: ReadonlySet<string>;  // 2-char
  headings: ReadonlySet<string>;  // 4-char
  hs6: ReadonlySet<string>;       // 6-char
  hs8: ReadonlySet<string>;       // 8-char
  hs10: ReadonlySet<string>;      // 10-char
}

const DIGIT_RUN = /\d{1,}/g;

export function digitNormalize(input: string, known: KnownPrefixes): DigitNormalizeResult {
  const detected: DigitNormalizeResult['detected'] = [];
  let prefixBias: string | null = null;

  const cleanedText = input.replace(DIGIT_RUN, (match) => {
    const len = match.length;

    // <4 → keep as text noise (do nothing, leave the digits in place)
    if (len < 4) {
      detected.push({ run: match, action: 'kept_as_text' });
      return match;
    }

    // >12 → text noise
    if (len > 12) {
      detected.push({ run: match, action: 'kept_as_text' });
      return match;
    }

    // Exactly 12 → deferred for v1 (ADR-0003)
    if (len === 12) {
      detected.push({ run: match, action: 'deferred_12' });
      return match;
    }

    // 4-11: check progressively longer real prefixes for a match
    let matchedPrefix: string | null = null;
    for (const tryLen of [10, 8, 6, 4]) {
      if (len < tryLen) continue;
      const candidate = match.slice(0, tryLen);
      const set =
        tryLen === 10 ? known.hs10 :
        tryLen === 8  ? known.hs8 :
        tryLen === 6  ? known.hs6 :
        known.headings;
      if (set.has(candidate)) {
        matchedPrefix = candidate;
        break;
      }
    }
    // Also try chapter (2-digit) only when the whole run is exactly 4 with no match yet
    // (Skipped — chapters are too coarse to bias on.)

    if (matchedPrefix) {
      // Keep first matched prefix as bias; if multiple runs match, take the longest seen so far
      if (!prefixBias || matchedPrefix.length > prefixBias.length) {
        prefixBias = matchedPrefix;
      }
      detected.push({ run: match, action: 'biased' });
      return match; // keep digits in cleaned text — they may carry meaning for retrieval too
    }

    // No prefix match → strip silently
    detected.push({ run: match, action: 'stripped' });
    return ' ';
  });

  return {
    cleanedText: cleanedText.replace(/\s+/g, ' ').trim(),
    prefixBias,
    detected,
  };
}
