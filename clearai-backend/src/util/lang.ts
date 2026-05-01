/**
 * Cheap language detection by Arabic vs Latin character count. LangTag is
 * re-exported from types/domain for backwards compatibility.
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
