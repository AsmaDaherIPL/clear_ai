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
 *
 * The shape is a discriminated union on `kind`:
 *  - `clean_product` — one identifiable item, canonical + family hint
 *  - `multi_product` — two or more distinct items in the same line
 *  - `uninformative` — LLM could not identify (or transport failed)
 *
 * All variants carry a `trace` sibling so the orchestrator can record
 * audit fields uniformly (per the rationale's "every item carries a
 * structured trace" principle). The trace is independent of `kind`
 * because every code path — short-circuit, transport failure, parse
 * failure, contract violation, happy path — produces an audit row.
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
       * Source of the identification. Cross-checked against the
       * transport-level tool-use signal — when self-reported and
       * actual disagree, `trace.evidence_mismatch` is true and the
       * actual value (from transport) wins.
       */
      evidence: 'web' | 'world_knowledge';
      trace: IdentifyCallTrace;
    }
  | {
      kind: 'multi_product';
      /** Short labels per detected product (>=2 items). */
      products: string[];
      trace: IdentifyCallTrace;
    }
  | {
      kind: 'uninformative';
      /** Short reason in 5-12 words. */
      reason: string;
      /**
       * Cause discriminator. Lets the orchestrator + metrics
       * distinguish:
       *  - 'genuine' — LLM ran and emitted kind=uninformative
       *  - 'short_circuit' — empty/whitespace input, no LLM call
       *  - 'transport' — LLM call errored or timed out
       *  - 'parse' — JSON could not be extracted from LLM text
       *  - 'contract' — LLM returned out-of-contract shape
       *    (unknown kind, empty canonical on clean_product, multi
       *    with <2 products)
       *
       * Genuine uninformatives indicate upstream data quality issues;
       * the other four indicate LLM-side problems that monitoring
       * should distinguish from data quality drift.
       */
      cause: 'genuine' | 'short_circuit' | 'transport' | 'parse' | 'contract';
      trace: IdentifyCallTrace;
    };

/**
 * Per-call audit metadata that travels alongside every IdentifyResult.
 * Independent of `kind` because every code path produces a trace row,
 * including the no-LLM short-circuit.
 */
export interface IdentifyCallTrace {
  /** Whether the LLM call actually fired. False on short-circuit paths. */
  llm_called: boolean;
  /** Wall-clock latency for the LLM call in ms. 0 on short-circuit. */
  latency_ms: number;
  /**
   * Model identifier returned by the LLM transport. Null when no call
   * fired (short-circuit) or when the transport produced no model
   * string.
   */
  model: string | null;
  /**
   * Transport status from the LLM call:
   *  - 'ok' — call returned text
   *  - 'error' — transport-level error
   *  - 'timeout' — request timed out
   *  - 'skipped' — no LLM call (short-circuit on empty input)
   */
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  /**
   * True iff the LLM's tool-use blocks indicate a web search was
   * actually issued. Cross-checked against the LLM's self-reported
   * `evidence` field — when they disagree, the actual transport
   * signal is the source of truth, and `evidence_mismatch` is set.
   */
  web_search_used: boolean;
  /**
   * True when the LLM self-reported `evidence: 'web'` but the
   * transport's tool-use blocks show no web search ran (or
   * vice versa). Diagnostic only; the actual `evidence` field on
   * `clean_product` is set from the transport signal.
   */
  evidence_mismatch: boolean;
}
