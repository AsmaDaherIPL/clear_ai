/**
 * Drops candidates whose HS chapter is incompatible with strong keyword
 * signals in the description. Runs before the picker LLM so it doesn't
 * burn tokens producing does_not_fit verdicts on impossible candidates.
 *
 * False-positive cost (dropping the right candidate) is a wrong
 * classification; false-negative cost (keeping a wrong candidate that
 * would have been rejected anyway) is one wasted LLM verdict. So only
 * high-confidence keyword→chapter mappings belong here.
 */
import type { Candidate } from '../../../../../inference/retrieval/retrieve.js';

/** Safety floor — never filter the candidate set below this count. */
const MIN_CANDIDATES = 3;

const KEYWORD_CHAPTERS: Array<{ pattern: RegExp; chapters: ReadonlyArray<string> }> = [
  { pattern: /\b(headphones?|earphones?|earbuds?|airpods?)\b/i, chapters: ['85'] },
  { pattern: /سماعات?\s*(?:رأس|أذن|راس)/i, chapters: ['85'] },
  { pattern: /\b(smartphone|mobile\s+phone|cellular\s+phone|iphone|android\s+phone)\b/i, chapters: ['85'] },
  { pattern: /\b(ssd|hard\s+drive|flash\s+memory|usb\s+drive|memory\s+card)\b/i, chapters: ['85'] },
  { pattern: /\b(laptop|notebook\s+computer|tablet\s+computer|ipad)\b/i, chapters: ['84'] },
  { pattern: /\b(sunscreen|sun\s+block|spf\s*\d+|واقي\s+شمس|واقي\s+الشمس)\b/i, chapters: ['33'] },
  { pattern: /\b(eyeliner|eyeshadow|mascara|lipstick|foundation\s+(makeup|cream))\b/i, chapters: ['33'] },
  { pattern: /\b(hair\s+(color|dye|spray|gel|cream|oil|conditioner|shampoo))\b/i, chapters: ['33'] },
  { pattern: /محضرات?\s+(?:صبغ|تجميل|العناية)/i, chapters: ['33'] },
  { pattern: /\b(hoodie|sweatshirt|sweater|cardigan|pullover|jumper)\b/i, chapters: ['61'] },
  { pattern: /هودي|كنزة|كارديجان/i, chapters: ['61'] },
  { pattern: /\b(t-shirt|tshirt|tee\s+shirt|polo\s+shirt)\b/i, chapters: ['61', '62'] },
  { pattern: /\b(jeans|denim\s+(pants|trousers))\b/i, chapters: ['62'] },
  { pattern: /\b(dress(es)?|gown)\b/i, chapters: ['61', '62'] },
  { pattern: /فساتين|فستان/i, chapters: ['61', '62'] },
  { pattern: /\b(jacket|blazer|coat|overcoat|parka|anorak|windbreaker)\b/i, chapters: ['61', '62'] },
  { pattern: /جاكيت|معطف|سترة/i, chapters: ['61', '62'] },
  { pattern: /\b(trousers|pants|leggings|breeches|shorts)\b/i, chapters: ['61', '62'] },
  { pattern: /بنطلون|بنطلونات/i, chapters: ['61', '62'] },
  { pattern: /\b(socks|stockings|pantyhose|tights|hosiery)\b/i, chapters: ['61'] },
  { pattern: /جوارب/i, chapters: ['61'] },
  { pattern: /\b(shoes?|footwear|sneakers?|trainers?|boots?|sandals?)\b/i, chapters: ['64'] },
  { pattern: /أحذية|حذاء/i, chapters: ['64'] },
  { pattern: /\b(crayons?|pastels?|chalks?)\b/i, chapters: ['96'] },
  { pattern: /\b(markers?|highlighters?|felt[\s-]?tip)\b/i, chapters: ['96'] },
  { pattern: /\bpencils?\b/i, chapters: ['96'] },
  { pattern: /\b(book|textbook|novel|magazine|brochure|leaflet)\b/i, chapters: ['49'] },
  { pattern: /كتاب|كتب/i, chapters: ['49'] },
  { pattern: /\b(thermos|vacuum\s+flask|insulated\s+(bottle|flask|mug))\b/i, chapters: ['96'] },
  { pattern: /قارورة\s+حرارية/i, chapters: ['96'] },
  { pattern: /\b(incense|agarbatti|bakhoor|بخور|عود\s+بخور)\b/i, chapters: ['33'] },

  // Toys / games / construction sets (chapter 95). Critical: these can be
  // mis-classified as magnets (85), models (90), or other chapters when the
  // description literalises the construction material instead of the toy
  // function. "Building blocks" alone is ambiguous; pair it with toy signals.
  { pattern: /\b(lego|magicube|geomag|playmobil|brio|meccano)\b/i, chapters: ['95'] },
  { pattern: /\b(building\s+(blocks?|set|kit|toy))\b/i, chapters: ['95'] },
  { pattern: /\b(construction\s+(set|kit|toy))\b/i, chapters: ['95'] },
  { pattern: /\b(toy|toys|playset|action\s+figure|board\s+game|jigsaw\s+puzzle)\b/i, chapters: ['95'] },
  { pattern: /\b(stuffed\s+(animal|toy)|plush\s+toy|soft\s+toy|teddy\s+bear)\b/i, chapters: ['95'] },
  { pattern: /\b(doll|dolls|dollhouse)\b/i, chapters: ['95'] },
  { pattern: /\b(model\s+(car|train|airplane|kit)\b|die[\s-]?cast\s+model)/i, chapters: ['95'] },
  { pattern: /\b(skateboard|roller\s+skates?|scooter\s+(for\s+kids?|toy)|kick\s+scooter)\b/i, chapters: ['95'] },
  { pattern: /ألعاب|لعبة|دمى|دمية/i, chapters: ['95'] },

  // Hair accessories (chapter 61 knitted, 65 textile). "Headband" in
  // English means a hair accessory; the catalogue's literal Arabic match
  // ('uqul / عقل) is a Saudi traditional cord — wrong chapter for a
  // generic hair headband. Scope to 61/65 to keep both viable.
  { pattern: /\b(headband|hair\s+band|sweat\s+band)\b/i, chapters: ['61', '65'] },
];

export function filterByChapterCoherence(
  candidates: Candidate[],
  effective_description: string,
): { filtered: Candidate[]; matchedChapters: string[]; aborted: boolean } {
  const matchedChapters = new Set<string>();
  for (const entry of KEYWORD_CHAPTERS) {
    if (entry.pattern.test(effective_description)) {
      for (const ch of entry.chapters) matchedChapters.add(ch);
    }
  }

  if (matchedChapters.size === 0) {
    return { filtered: candidates, matchedChapters: [], aborted: false };
  }

  const filtered = candidates.filter((c) => matchedChapters.has(c.code.slice(0, 2)));

  if (filtered.length < MIN_CANDIDATES) {
    return {
      filtered: candidates,
      matchedChapters: Array.from(matchedChapters).sort(),
      aborted: true,
    };
  }

  return {
    filtered,
    matchedChapters: Array.from(matchedChapters).sort(),
    aborted: false,
  };
}
