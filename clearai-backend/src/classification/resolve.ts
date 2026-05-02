/** Maps (gate outcome, LLM result, guards) → final (decision_status, decision_reason). */
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
  /** Null when the gate failed (LLM not called). */
  llm: LlmPickResult | null;
  alreadyMostSpecific?: boolean;
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
  if (input.alreadyMostSpecific) {
    return {
      decisionStatus: 'accepted',
      decisionReason: 'already_most_specific',
      confidenceBand: 'high',
      chosenCode: null,
      rationale: 'Already at the most specific level; no narrower descendant available.',
      missingAttributes: [],
    };
  }

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

  return {
    decisionStatus: 'accepted',
    decisionReason: input.singleValidDescendant ? 'single_valid_descendant' : 'strong_match',
    confidenceBand: undefined,
    chosenCode: input.llm.chosenCode,
    rationale: input.llm.rationale,
    missingAttributes: [],
  };
}
