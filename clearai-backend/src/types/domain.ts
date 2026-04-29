/**
 * Domain vocabulary — every cross-cutting string-literal union the system
 * speaks. One file = one place to scan when you want to know "what are the
 * legal values for X?" without digging through five modules.
 *
 * Scope:
 *   ✓ Pure string-literal unions and the small enums that ride alongside them
 *   ✗ Structural interfaces (those stay with the code that produces them —
 *     EventInsert in observability/, ResolveInput in classification/, etc.)
 *   ✗ Types that close over runtime values (e.g. zod-derived shapes)
 *
 * Origin files re-export from here for backwards compatibility, so existing
 * `import type { LangTag } from '../util/lang.js'` keeps working. Prefer
 * importing from `../types/domain.js` in new code.
 */

// ---- Language detection -----------------------------------------------------

/**
 * Cheap language tag attached to every classification event. `unk` covers
 * inputs with no Latin or Arabic letters at all (e.g. all-digit / all-emoji).
 * `mixed` fires when both scripts appear — common for Arabic descriptions
 * with English brand names.
 */
export type LangTag = 'en' | 'ar' | 'mixed' | 'unk';

// ---- Decision contract (ADR-0001 / ADR-0011) --------------------------------

/**
 * The four UI states every classification response collapses into. Each maps
 * onto a distinct frontend affordance — the frontend MUST visually distinguish
 * them. `accepted` is the only one safe to autopopulate downstream forms with.
 *
 *   accepted              — confident leaf or heading-level match
 *   needs_clarification   — gate refused; ask the user for more detail
 *   degraded              — operational failure (LLM unavailable, etc.)
 *   best_effort           — low-confidence fallback heading, gated behind a
 *                           verify-toggle in the UI (ADR-0011)
 */
export type DecisionStatus =
  | 'accepted'
  | 'needs_clarification'
  | 'degraded'
  | 'best_effort';

/**
 * Why the system reached the status it did. Surfaced on the response and
 * persisted on the event row for trace replay.
 */
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
  /**
   * Heading-level match: confident HS-4 family, can't commit to a leaf
   * without an attribute the input doesn't supply. Paired with
   * `decision_status = 'accepted'` and `confidence_band = 'medium'`.
   */
  | 'heading_level_match';

export type ConfidenceBand = 'high' | 'medium' | 'low';

/**
 * Structured "what would the user need to add to get a confident leaf?"
 * tag. Surfaced on heading-level matches so the frontend can suggest a
 * targeted refinement question.
 */
export type MissingAttribute =
  | 'material'
  | 'intended_use'
  | 'product_type'
  | 'dimensions'
  | 'composition';

// ---- Evidence gate ----------------------------------------------------------

/**
 * Why the evidence gate refused. Mirrored as a substring of `DecisionReason`
 * (the gate's reason is what gets surfaced when the gate fails-closed).
 */
export type GateRefusalReason =
  | 'weak_retrieval'
  | 'ambiguous_top_candidates'
  | 'invalid_prefix';

// ---- Interpretation block ---------------------------------------------------

/**
 * Pipeline stage the input reached before retrieval ran. Surfaced on the
 * response so the frontend can render "we read this as: …".
 */
export type InterpretationStage = 'passthrough' | 'cleaned' | 'researched' | 'unknown';

// ---- Merchant cleanup (Phase 1.5) -------------------------------------------

/**
 * What kind of input the cleanup LLM thinks this is.
 *
 *   product             — a real product description we can classify
 *   merchant_shorthand  — short codes / SKUs the LLM expanded into a noun
 *   ungrounded          — not classifiable; route to needs_clarification
 */
export type MerchantCleanupKind = 'product' | 'merchant_shorthand' | 'ungrounded';

// ---- LLM client -------------------------------------------------------------

export type LlmStatus = 'ok' | 'error' | 'timeout';

// ---- Trace feedback (POST /trace/:eventId/feedback) -------------------------

/**
 * The three feedback kinds a user can record on a classification event.
 *
 *   confirm              — "this code is correct"
 *   reject               — "this code is wrong" (no replacement supplied)
 *   prefer_alternative   — "this code is wrong; here's what I'd use instead"
 *                          (carries `corrected_code`)
 */
export type FeedbackKind = 'confirm' | 'reject' | 'prefer_alternative';
