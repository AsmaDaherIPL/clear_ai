/**
 * Digit normalization (ADR-0003). Strips or biases digit runs in free-text
 * inputs based on whether they match a known tariff prefix.
 */

export interface DigitNormalizeResult {
  cleanedText: string;
  /** If set, retrieval soft-biases candidates starting with this prefix. */
  prefixBias: string | null;
  detected: Array<{ run: string; action: 'kept_as_text' | 'stripped' | 'biased' | 'deferred_12' }>;
}

export interface KnownPrefixes {
  chapters: ReadonlySet<string>;
  headings: ReadonlySet<string>;
  hs6: ReadonlySet<string>;
  hs8: ReadonlySet<string>;
  hs10: ReadonlySet<string>;
}

const DIGIT_RUN = /\d{1,}/g;

export function digitNormalize(input: string, known: KnownPrefixes): DigitNormalizeResult {
  const detected: DigitNormalizeResult['detected'] = [];
  let prefixBias: string | null = null;

  const cleanedText = input.replace(DIGIT_RUN, (match) => {
    const len = match.length;

    if (len < 4 || len > 12) {
      detected.push({ run: match, action: 'kept_as_text' });
      return match;
    }

    if (len === 12) {
      detected.push({ run: match, action: 'deferred_12' });
      return match;
    }

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

    if (matchedPrefix) {
      if (!prefixBias || matchedPrefix.length > prefixBias.length) {
        prefixBias = matchedPrefix;
      }
      detected.push({ run: match, action: 'biased' });
      return match;
    }

    detected.push({ run: match, action: 'stripped' });
    return ' ';
  });

  return {
    cleanedText: cleanedText.replace(/\s+/g, ' ').trim(),
    prefixBias,
    detected,
  };
}
