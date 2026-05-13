/**
 * Curated brand → 2-digit HS chapter map (PR5 / Layer 4).
 *
 * Used by cleanup as a retrieval-widening hint: when a known brand appears
 * in the raw input, cleanup emits the brand's chapter so retrieval can mix
 * in chapter-scoped candidates if the unconstrained pass missed that
 * family entirely. Same mechanism as PR3's web-researcher family hint —
 * the source is just a static table instead of LLM reasoning.
 *
 * Discipline:
 *  - Keep this map small and high-precision. A wrong hint widens into the
 *    wrong chapter; the picker has to drop it. Better to omit a brand
 *    than to add an uncertain entry.
 *  - Chapters are 2-digit only. Headings/subheadings change too often.
 *  - Brand-as-key only when the brand is mono-category. Multi-category
 *    brands (Sony, Samsung, Apple, Nike) DO NOT belong here — they ship
 *    products across many chapters.
 *  - Match is case-insensitive substring on whitespace-delimited tokens.
 *    A brand "lego" matches "Lego Education Spike Essential Set" but
 *    NOT "legobacht" or "klego".
 *
 * Source for additions: classification incidents like the 2026-05-13 batch
 * (rows 34, 50: Intex toys, Lego ambulance) where retrieval missed Ch 95
 * because the catalog vocabulary doesn't include common toy brand names.
 *
 * To add: append to BRAND_TO_CHAPTER below; new entries should cite the
 * specific failure mode they fix or a representative product that
 * unambiguously belongs to the named chapter.
 */

/**
 * Map of lowercased brand token → 2-digit HS chapter.
 *
 * Each entry is a single lowercase token. Multi-word brands (e.g.
 * "tory burch") match if ANY of their tokens hits the input — but
 * because of the multi-category-brand rule above, multi-word brands
 * are mostly avoided here.
 */
const BRAND_TO_CHAPTER: Record<string, string> = {
  // Toy chapter (95) — mono-category brands missed by retrieval
  lego: '95',
  duplo: '95',
  playmobil: '95',
  meccano: '95',
  geomag: '95',
  magicube: '95',
  brio: '95',
  intex: '95',     // pool / inflatable toys
  fisher: '95',    // Fisher-Price (also bare token "fisher")
  hasbro: '95',
  mattel: '95',
  ravensburger: '95',
  bandai: '95',
  pokemon: '95',
  pokémon: '95',

  // Baby carriages / strollers (Ch 87)
  joolz: '87',
  bugaboo: '87',
  babybjorn: '87',  // bouncers are 94, but Ch 87 covers strollers & baby
                    // carriages — when the line is unclear, picker decides
  babyzen: '87',
  uppababy: '87',
  silvercross: '87',
  doona: '87',

  // Eyewear / optical (Ch 90)
  rayban: '90',
  oakley: '90',
  warbyparker: '90',

  // Watches (Ch 91) — note: NOT smartwatches (those are Ch 85)
  rolex: '91',
  omega: '91',
  patek: '91',
  swatch: '91',

  // Cosmetics / personal care (Ch 33)
  loreal: '33',
  loréal: '33',
  garnier: '33',
  nivea: '33',
  maybelline: '33',
  revolution: '33', // Makeup Revolution
  biomagic: '33',

  // Pharmaceutical (Ch 30)
  pfizer: '30',
  novartis: '30',
  bayer: '30',      // bayer makes both pharma + chemicals, but most
                    // consumer-line product mentions are aspirin / drugs

  // Camera / photographic (Ch 90)
  nikon: '90',
  canon: '90',
  fujifilm: '90',
  smallrig: '90',   // camera rigs / mounts

  // Pet supplies (Ch 23 = pet food; substrates may be Ch 44/14/25)
  whiskas: '23',
  pedigree: '23',
  royalcanin: '23',
  hillsdiet: '23',
};

/**
 * Tokenize an input string for brand matching. Lowercase + whitespace
 * split + strip punctuation. Empty for empty/whitespace input.
 */
function tokenize(input: string): string[] {
  if (!input) return [];
  return input
    .toLowerCase()
    .split(/[\s,;:.()/\-—–'"]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

/**
 * Look up a 2-digit HS chapter hint from the brand map for the given
 * raw or cleaned description. Returns the first match, or empty string
 * when no brand matches.
 *
 * First-match-wins is fine because we curate the map to be unambiguous.
 * If two known brands appear in the same input (rare), the earlier-
 * tokenized one wins.
 */
export function lookupBrandChapter(input: string): string {
  for (const tok of tokenize(input)) {
    const chapter = BRAND_TO_CHAPTER[tok];
    if (chapter) return chapter;
  }
  return '';
}
