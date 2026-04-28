/**
 * Shared decision contract — see V1_PLAN §A.5 and ADR-0001 / ADR-0011.
 * No numeric `confidence` anywhere. `confidence_band` is optional and calibrated.
 *
 * The four `decision_status` values map onto distinct UI affordances. The
 * frontend MUST visually distinguish them — accepted is the only one safe to
 * autopopulate downstream forms with.
 */

export type DecisionStatus =
  | 'accepted'
  | 'needs_clarification'
  | 'degraded'
  /**
   * v2/ADR-0011: a low-confidence fallback heading (4-digit by default,
   * tunable via setup_meta.BEST_EFFORT_MAX_DIGITS). Only ever paired with
   * `decision_reason = 'best_effort_heading'` and `confidence_band = 'low'`.
   * The frontend gates this behind a verify-toggle so users do not mistake
   * it for an accepted classification.
   */
  | 'best_effort';

export type DecisionReason =
  | 'strong_match'
  | 'single_valid_descendant'
  | 'already_most_specific'
  | 'weak_retrieval'
  | 'ambiguous_top_candidates'
  | 'invalid_prefix'
  | 'guard_tripped'
  | 'llm_unavailable'
  /**
   * Set when the input contains brand/SKU/jargon and the Sonnet researcher
   * returns UNKNOWN — i.e. neither retrieval nor world-knowledge can identify
   * the underlying product. The honest alternative to a confident-wrong code.
   */
  | 'brand_not_recognised'
  /**
   * v2/ADR-0011: best-effort fallback emitted a 2/4/6/8/10-digit heading
   * (capped by `BEST_EFFORT_MAX_DIGITS`, default 4). Always paired with
   * `decision_status = 'best_effort'` and `confidence_band = 'low'`.
   */
  | 'best_effort_heading'
  /**
   * Heading-level acceptance — the route confidently identified an HS
   * heading (4-digit family, e.g. 4202 for bags or 6403 for footwear)
   * but cannot commit to a sub-heading or leaf without an attribute the
   * input doesn't supply (typically material). The chosen code is the
   * heading-padded 12-digit form (e.g. `420200000000`), which ZATCA
   * accepts as a valid customs declaration with a published duty rate.
   * Always paired with `decision_status = 'accepted'` and
   * `confidence_band = 'medium'`. The frontend should render this as a
   * legitimate accepted classification with a soft "heading-level — add
   * the material to refine" eyebrow, NOT the verify-toggle gating used
   * for best_effort.
   */
  | 'heading_level_match';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export type MissingAttribute =
  | 'material'
  | 'intended_use'
  | 'product_type'
  | 'dimensions'
  | 'composition';

