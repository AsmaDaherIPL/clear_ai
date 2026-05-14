/**
 * Typed contracts for the identify stage (PR-A-2).
 *
 * Declared in PR-A-1 alongside the stub so the contract is locked
 * before the implementation lands. PR-A-2 fills in `runIdentify`'s
 * body against this contract.
 */

/**
 * Result of identifying a single line item from its raw description.
 *
 * Blinded to the merchant code (per the design rationale's
 * anchoring-avoidance principle).
 */
export type IdentifyResult =
  | {
      kind: 'clean_product';
      /** Brand-free tariff-English customs noun (4-18 words). */
      canonical: string;
      /** 2-digit HS chapter hint, or null when no confident hint. */
      family_chapter: string | null;
      /**
       * Up to 4 lexical anchors that survived stripping (book titles,
       * active-ingredient names, brand-as-chapter identifiers,
       * foreign-language customs nouns). Replaces today's PR2
       * identity_tokens.
       */
      identity_tokens: string[];
      /** Self-rated confidence 0-1. NOT calibrated; relative only. */
      confidence: number;
      /**
       * Source of the identification. `web` when the LLM tool-called
       * web search; `world_knowledge` when the canonical was derived
       * from training memory alone.
       */
      evidence: 'web' | 'world_knowledge';
    }
  | {
      kind: 'multi_product';
      /** Short labels per detected product (>=2 items). */
      products: string[];
    }
  | {
      kind: 'uninformative';
      /** Short reason in 5-12 words. */
      reason: string;
    };
