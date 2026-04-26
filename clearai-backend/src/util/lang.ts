/**
 * Cheap language detection: counts Arabic vs Latin characters. Good enough
 * for logging classification_events.language_detected.
 */
export type LangTag = 'en' | 'ar' | 'mixed' | 'unk';

const ARABIC_RANGE = /[\u0600-\u06FF\u0750-\u077F]/;
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
