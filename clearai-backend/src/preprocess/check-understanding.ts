/**
 * Retrieval-grounded "did the system understand this input?" check.
 *
 * V3 (ADR-0020): composite signal across THREE dimensions, not just chapter
 * coherence. The original chapter-coherence-only signal failed silently on
 * "Loewe Puzzle bag" — retrieval converged on chapter 42 (coherent!) but on
 * the wrong heading (4205 leather articles instead of 4202 bags). Coherent
 * but wrong-family is a real failure mode and the V2 signal couldn't see
 * it. The V3 signal returns:
 *
 *   strong   — chapter coherent AND noun-aligned (or no noun supplied) AND
 *              retrieval arms agree. Skip the researcher.
 *   weak     — coherent but noun is missing from top results, OR retrieval
 *              arms disagree on the family. Run the researcher; retrieval's
 *              "convergence" may be on the wrong family.
 *   scattered — chapters scattered widely (the V2 case). Run the researcher.
 *
 * The new noun-alignment signal is what catches the Loewe Puzzle bag class:
 * cleanup extracted the customs noun "bag" but retrieval's top results all
 * say "leather articles, desk pads, buckle parts" — none contain "bag". The
 * noun is the strongest evidence the user gave us; if retrieval's top
 * results don't reflect it, retrieval understood the wrong product.
 *
 * Thresholds are loaded from setup_meta so the team can tune without redeploys.
 */
import type { Candidate } from '../retrieval/retrieve.js';

export type UnderstandingReason =
  | 'incoherent_top_set'
  | 'noun_misaligned'
  | 'arms_disagree';

/** Tri-state strength so the caller can route weak vs scattered differently. */
export type UnderstandingStrength = 'strong' | 'weak' | 'scattered';

export interface UnderstandingResult {
  /**
   * Backwards-compat boolean. true ↔ strength === 'strong'. Existing call
   * sites that branch on `understood` get the safer behaviour automatically:
   * weak and scattered both route to the researcher.
   */
  understood: boolean;
  /** New: tri-state. Lets routing distinguish "rerun via researcher" from "abstain". */
  strength: UnderstandingStrength;
  reason: UnderstandingReason | null;
  /** Distinct HS-2 chapters among top-N candidates. 1 = highly coherent. */
  distinctChapters: number;
  /** The chapters themselves, sorted, for logging/debugging. */
  chapters: string[];
  /** Whether the customs noun (if any) appeared in any top-N description. */
  nounAligned: boolean | null;
  /** The noun that was checked for alignment, if any. */
  nounChecked: string | null;
  /** The threshold that was applied (max distinct chapters tolerated). */
  threshold: number;
}

/**
 * Lightweight noun-alignment check: does the customs noun (e.g. "bag",
 * "perfume", "shoes") appear as a substring in any of the top-N retrieval
 * results' EN descriptions? Multilingual: also checks AR descriptions when
 * the noun looks Arabic.
 *
 * Synonym handling is deliberately small and curated — not a model call.
 * Customs nouns are a small closed set in practice and the signal we want
 * is "did retrieval surface things that look like this kind of product?"
 * One synonym layer of indirection is enough; more would mean we're
 * second-guessing retrieval which defeats the point.
 */
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
  /**
   * Optional customs noun extracted by Phase 1.5 cleanup (e.g. "bag",
   * "perfume"). When provided, the noun-alignment check runs against the
   * top-N retrieval results. Missing → noun-alignment is skipped (treated
   * as neither strengthening nor weakening the signal).
   */
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

  // Edge case: zero or one candidate is already a low-information situation;
  // we route to the existing evidence gate to handle it. Don't claim "understood"
  // off the back of a single retrieval hit.
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

  // ---- Signal 1: chapter coherence -----------------------------------------
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

  // ---- Signal 2: noun-family alignment -------------------------------------
  // Only meaningful when cleanup gave us a customs noun. Check if the noun
  // (or any synonym) appears in any top-N result's EN or AR description.
  // If not, retrieval converged on a family that doesn't describe the
  // product the user actually has — the V2 silent failure mode.
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

  // ---- All signals strong --------------------------------------------------
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
