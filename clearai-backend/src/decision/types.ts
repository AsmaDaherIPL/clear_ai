/**
 * Shared decision contract — see V1_PLAN §A.5 and ADR-0001.
 * No numeric `confidence` anywhere. `confidence_band` is optional and calibrated.
 */

export type DecisionStatus = 'accepted' | 'needs_clarification' | 'degraded';

export type DecisionReason =
  | 'strong_match'
  | 'single_valid_descendant'
  | 'already_most_specific'
  | 'weak_retrieval'
  | 'ambiguous_top_candidates'
  | 'invalid_prefix'
  | 'guard_tripped'
  | 'llm_unavailable';

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
  retrieval_score: number;
}
