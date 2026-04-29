/**
 * Cheap language detection: counts Arabic vs Latin characters. Good enough
 * for logging classification_events.language_detected.
 *
 * `LangTag` lives in src/types/domain.ts (single home for cross-cutting
 * unions). Re-exported here for backwards compatibility with existing
 * `import type { LangTag } from '../util/lang.js'` call sites.
 */
import type { LangTag } from '../types/domain.js';
export type { LangTag } from '../types/domain.js';

const ARABIC_RANGE = /[؀-ۿݐ-ݿ]/;
const LATIN_RANGE = /[A-Za-z]/;

export function detectLang(input: string): LangTag {
  let ar = 0;
  let en = 0;
  for (const ch of input) {
    if (ARABIC_RANGE.test(ch)) ar++;
    else if (LATIN_RANGE.test(ch)) en++;
  }
  if (ar === 0 && en === 0) return 'unk';
  if (ar > 0 && en > 0) return 'mixed';
  return ar > en ? 'ar' : 'en';
}
