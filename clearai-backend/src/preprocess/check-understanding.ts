/**
 * Understanding signal (ADR-0020). Combines chapter coherence and noun-family
 * alignment to decide whether to run the researcher.
 */
import type { Candidate } from '../retrieval/retrieve.js';

export type UnderstandingReason =
  | 'incoherent_top_set'
  | 'noun_misaligned'
  | 'arms_disagree';

export type UnderstandingStrength = 'strong' | 'weak' | 'scattered';

export interface UnderstandingResult {
  /** Back-compat: true ↔ strength === 'strong'. */
  understood: boolean;
  strength: UnderstandingStrength;
  reason: UnderstandingReason | null;
  /** Distinct HS-2 chapters among top-N. 1 = highly coherent. */
  distinctChapters: number;
  chapters: string[];
  nounAligned: boolean | null;
  nounChecked: string | null;
  threshold: number;
}

const NOUN_SYNONYMS: Record<string, string[]> = {
  bag: ['bag', 'handbag', 'rucksack', 'backpack', 'purse', 'wallet', 'satchel', 'pouch', 'حقيبة', 'حقائب', 'كيس', 'محفظة'],
  shoe: ['shoe', 'footwear', 'sandal', 'boot', 'sneaker', 'حذاء', 'أحذية', 'صندل'],
  shoes: ['shoe', 'footwear', 'sandal', 'boot', 'sneaker', 'حذاء', 'أحذية', 'صندل'],
  perfume: ['perfume', 'fragrance', 'eau de', 'toilet water', 'cologne', 'عطر', 'عطور', 'كولونيا'],
  perfumes: ['perfume', 'fragrance', 'eau de', 'toilet water', 'cologne', 'عطر', 'عطور', 'كولونيا'],
  watch: ['watch', 'wristwatch', 'timepiece', 'ساعة', 'ساعات'],
  phone: ['phone', 'smartphone', 'mobile', 'cellular', 'هاتف', 'جوال'],
  smartphone: ['smartphone', 'phone', 'mobile', 'cellular', 'هاتف ذكي'],
  trousers: ['trouser', 'pants', 'بنطلون', 'سروال'],
  pants: ['trouser', 'pants', 'بنطلون', 'سروال'],
  shirt: ['shirt', 't-shirt', 'tshirt', 'قميص'],
  'tshirt': ['shirt', 't-shirt', 'tshirt', 'قميص'],
  't-shirt': ['shirt', 't-shirt', 'tshirt', 'قميص'],
  headphones: ['headphone', 'earphone', 'headset', 'earbud', 'سماعة', 'سماعات'],
};

function expandNoun(noun: string): string[] {
  const key = noun.trim().toLowerCase();
  return NOUN_SYNONYMS[key] ?? [key];
}

function nounMatchesText(nouns: string[], text: string | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return nouns.some((n) => n.length > 0 && t.includes(n.toLowerCase()));
}

export interface CheckUnderstandingOpts {
  maxDistinctChapters: number;
  topK: number;
  /** Optional customs noun from Phase 1.5 cleanup (e.g. "bag", "perfume"). */
  customsNoun?: string | null;
}

export function checkUnderstanding(
  candidates: Candidate[],
  opts: CheckUnderstandingOpts,
): UnderstandingResult {
  const window = candidates.slice(0, opts.topK);
  const chapters = Array.from(new Set(window.map((c) => c.code.slice(0, 2)))).sort();
  const distinctChapters = chapters.length;
  const noun = opts.customsNoun?.trim() || null;

  // Zero or one candidate — let the evidence gate decide.
  if (window.length < 2) {
    return {
      understood: true,
      strength: 'strong',
      reason: null,
      distinctChapters,
      chapters,
      nounAligned: null,
      nounChecked: noun,
      threshold: opts.maxDistinctChapters,
    };
  }

  // Chapter coherence.
  if (distinctChapters > opts.maxDistinctChapters) {
    return {
      understood: false,
      strength: 'scattered',
      reason: 'incoherent_top_set',
      distinctChapters,
      chapters,
      nounAligned: null,
      nounChecked: noun,
      threshold: opts.maxDistinctChapters,
    };
  }

  // Noun-family alignment.
  let nounAligned: boolean | null = null;
  if (noun) {
    const synonyms = expandNoun(noun);
    nounAligned = window.some(
      (c) =>
        nounMatchesText(synonyms, c.description_en) ||
        nounMatchesText(synonyms, c.description_ar),
    );
    if (!nounAligned) {
      return {
        understood: false,
        strength: 'weak',
        reason: 'noun_misaligned',
        distinctChapters,
        chapters,
        nounAligned: false,
        nounChecked: noun,
        threshold: opts.maxDistinctChapters,
      };
    }
  }

  return {
    understood: true,
    strength: 'strong',
    reason: null,
    distinctChapters,
    chapters,
    nounAligned,
    nounChecked: noun,
    threshold: opts.maxDistinctChapters,
  };
}
