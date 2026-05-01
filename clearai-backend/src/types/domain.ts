/**
 * Domain vocabulary — every cross-cutting string-literal union the system
 * speaks, in one place.
 */

/** Cheap language tag attached to every classification event. */
export type LangTag = 'en' | 'ar' | 'mixed' | 'unk';

/** The four UI states every classification response collapses into. */
export type DecisionStatus =
  | 'accepted'
  | 'needs_clarification'
  | 'degraded'
  | 'best_effort';

/** Why the system reached the status it did. */
export type DecisionReason =
  | 'strong_match'
  | 'single_valid_descendant'
  | 'already_most_specific'
  | 'weak_retrieval'
  | 'ambiguous_top_candidates'
  | 'invalid_prefix'
  | 'guard_tripped'
  | 'llm_unavailable'
  /** Researcher returned UNKNOWN — input is brand/SKU/jargon we can't resolve. */
  | 'brand_not_recognised'
  /** Best-effort 2/4/6/8/10-digit fallback heading (ADR-0011). */
  | 'best_effort_heading'
  /** Confident HS-4 family without enough info to commit to a leaf. */
  | 'heading_level_match'
  /** Cleanup detected multiple distinct products in one input. */
  | 'multi_product_input'
  /** The submitted parent prefix exactly matches a SABER-deleted code. */
  | 'code_deleted';

export type ConfidenceBand = 'high' | 'medium' | 'low';

/** What attribute the user would need to add for a confident leaf. */
export type MissingAttribute =
  | 'material'
  | 'intended_use'
  | 'product_type'
  | 'dimensions'
  | 'composition';

/** Why the evidence gate refused. Mirrored into DecisionReason on failure. */
export type GateRefusalReason =
  | 'weak_retrieval'
  | 'ambiguous_top_candidates'
  | 'invalid_prefix';

/** Pipeline stage the input reached before retrieval ran. */
export type InterpretationStage = 'passthrough' | 'cleaned' | 'researched' | 'unknown';

/**
 * What kind of input the cleanup LLM thinks this is. `multi_product` is
 * surfaced separately from `product` so the route can refuse instead of
 * silently classifying one of the items.
 */
export type MerchantCleanupKind =
  | 'product'
  | 'merchant_shorthand'
  | 'ungrounded'
  | 'multi_product';

export type LlmStatus = 'ok' | 'error' | 'timeout';

/** The three feedback kinds a user can record on a classification event. */
export type FeedbackKind = 'confirm' | 'reject' | 'prefer_alternative';
