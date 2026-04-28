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
  | 'best_effort_heading';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export type MissingAttribute =
  | 'material'
  | 'intended_use'
  | 'product_type'
  | 'dimensions'
  | 'composition';

export interface DecisionEnvelope {
  decision_status: DecisionStatus;
  decision_reason: DecisionReason;
  confidence_band?: ConfidenceBand;
  rationale?: string;
  missing_attributes?: MissingAttribute[];
  model: {
    embedder: string;
    llm: string | null;
  };
}

export interface AlternativeCandidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  /**
   * RRF score when alternatives come from filtered retrieval; `null` when
   * alternatives come from deterministic branch enumeration (Phase 1 of
   * v3 alternatives redesign — `accepted` results enumerate the chosen
   * code's HS-6 branch from the catalog rather than expose retrieval rank).
   * The frontend should render the picker's-choice chip (no number) on
   * the chosen row and a "branch sibling" indicator on null-scored rows.
   */
  retrieval_score: number | null;
}
