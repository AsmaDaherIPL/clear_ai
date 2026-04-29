/**
 * Shared decision contract — see V1_PLAN §A.5 and ADR-0001 / ADR-0011.
 * No numeric `confidence` anywhere. `confidence_band` is optional and calibrated.
 *
 * The vocabulary unions live in src/types/domain.ts (single home for
 * cross-cutting types). This file re-exports them so existing imports
 * `from '../classification/types.js'` keep working.
 */
export type {
  DecisionStatus,
  DecisionReason,
  ConfidenceBand,
  MissingAttribute,
} from '../types/domain.js';
