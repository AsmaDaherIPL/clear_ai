/**
 * Decision Resolution (DR.1-DR.7) — single source of truth mapping
 * (gate outcome, llm result, guard) → (decision_status, decision_reason).
 *
 * confidence_band is left undefined for v1 (calibrated post-launch from eval data).
 */
import type {
  DecisionStatus,
  DecisionReason,
  ConfidenceBand,
  MissingAttribute,
} from './types.js';
import type { GateOutcome } from './evidence-gate.js';
import type { LlmPickResult } from './llm-pick.js';

export interface ResolveInput {
  gate: GateOutcome;
  llm: LlmPickResult | null; // null when gate failed (LLM not called)
  // For /boost short-circuit
  alreadyMostSpecific?: boolean;
  // For /expand single-descendant
  singleValidDescendant?: boolean;
}

export interface ResolveOutput {
  decisionStatus: DecisionStatus;
  decisionReason: DecisionReason;
  confidenceBand: ConfidenceBand | undefined;
  chosenCode: string | null;
  rationale: string | null;
  missingAttributes: MissingAttribute[];
}

export function resolve(input: ResolveInput): ResolveOutput {
  // 1. /boost short-circuit
  if (input.alreadyMostSpecific) {
    return {
      decisionStatus: 'accepted',
      decisionReason: 'already_most_specific',
      confidenceBand: 'high',
      chosenCode: null,
      rationale: 'No sibling beats the declared code by the configured BOOST_MARGIN.',
      missingAttributes: [],
    };
  }

  // 2. Gate failed → never called LLM
  if (!input.gate.passed) {
    return {
      decisionStatus: 'needs_clarification',
      decisionReason: input.gate.reason,
      confidenceBand: undefined,
      chosenCode: null,
      rationale: null,
      missingAttributes: [],
    };
  }

  // 3. Gate passed but LLM not run (only happens in pre-LLM unit-test paths)
  if (!input.llm) {
    return {
      decisionStatus: 'degraded',
      decisionReason: 'llm_unavailable',
      confidenceBand: undefined,
      chosenCode: null,
      rationale: null,
      missingAttributes: [],
    };
  }

  // 4. LLM operational failure
  if (input.llm.llmStatus !== 'ok') {
    return {
      decisionStatus: 'degraded',
      decisionReason: 'llm_unavailable',
      confidenceBand: undefined,
      chosenCode: null,
      rationale: null,
      missingAttributes: [],
    };
  }

  // 5. Hallucination guard tripped (or parse failed)
  if (input.llm.guardTripped) {
    return {
      decisionStatus: 'needs_clarification',
      decisionReason: 'guard_tripped',
      confidenceBand: undefined,
      chosenCode: null,
      rationale: input.llm.rationale,
      missingAttributes: input.llm.missingAttributes,
    };
  }

  // 6. LLM said "no fit" (chosenCode null, valid abstention)
  if (input.llm.chosenCode === null) {
    return {
      decisionStatus: 'needs_clarification',
      decisionReason: 'ambiguous_top_candidates',
      confidenceBand: undefined,
      chosenCode: null,
      rationale: input.llm.rationale,
      missingAttributes: input.llm.missingAttributes,
    };
  }

  // 7. Accepted
  return {
    decisionStatus: 'accepted',
    decisionReason: input.singleValidDescendant ? 'single_valid_descendant' : 'strong_match',
    confidenceBand: undefined, // calibrated later from eval data
    chosenCode: input.llm.chosenCode,
    rationale: input.llm.rationale,
    missingAttributes: [],
  };
}
