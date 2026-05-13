/**
 * Typed per-stage retry / timeout policy for LLM-backed pipeline stages.
 *
 * Hardcoded registry: type-safe, deploy to change, no runtime config lookup.
 * Promotion to env-driven config is deferred until incident response needs it.
 */

export type LlmStage =
  | 'cleanup'
  | 'researcher_cheap'
  | 'researcher_web'
  | 'picker'
  | 'code_resolver'
  | 'reconciliation'
  | 'submission_description'
  | 'sanity';

export type OnExhausted = 'escalate' | 'graceful_degrade' | 'fail_hard';

export interface LlmStagePolicy {
  stage: LlmStage;
  /** Total attempts including the first call. */
  maxAttempts: number;
  /** Per-attempt timeout in ms. */
  timeoutMs: number;
  /**
   * Whether to retry on parse / schema failures (in addition to the
   * transport-level retries on transient HTTP failures). When false,
   * a single parse failure ends the call.
   */
  retryOnParseFailure: boolean;
  /** Hard ceiling on total wall-clock across all attempts. */
  totalBudgetMs: number;
  /** What the caller should do when all attempts are exhausted. */
  onExhausted: OnExhausted;
}

const POLICIES: Record<LlmStage, LlmStagePolicy> = {
  cleanup:                { stage: 'cleanup',                maxAttempts: 3, timeoutMs: 5000,  retryOnParseFailure: true,  totalBudgetMs: 15000, onExhausted: 'graceful_degrade' },
  researcher_cheap:       { stage: 'researcher_cheap',       maxAttempts: 2, timeoutMs: 8000,  retryOnParseFailure: true,  totalBudgetMs: 15000, onExhausted: 'graceful_degrade' },
  researcher_web:         { stage: 'researcher_web',         maxAttempts: 1, timeoutMs: 30000, retryOnParseFailure: false, totalBudgetMs: 30000, onExhausted: 'graceful_degrade' },
  picker:                 { stage: 'picker',                 maxAttempts: 3, timeoutMs: 10000, retryOnParseFailure: true,  totalBudgetMs: 35000, onExhausted: 'graceful_degrade' },
  code_resolver:          { stage: 'code_resolver',          maxAttempts: 3, timeoutMs: 10000, retryOnParseFailure: true,  totalBudgetMs: 30000, onExhausted: 'escalate' },
  reconciliation:         { stage: 'reconciliation',         maxAttempts: 2, timeoutMs: 15000, retryOnParseFailure: true,  totalBudgetMs: 30000, onExhausted: 'escalate' },
  submission_description: { stage: 'submission_description', maxAttempts: 3, timeoutMs: 8000,  retryOnParseFailure: true,  totalBudgetMs: 25000, onExhausted: 'graceful_degrade' },
  sanity:                 { stage: 'sanity',                 maxAttempts: 3, timeoutMs: 6000,  retryOnParseFailure: true,  totalBudgetMs: 20000, onExhausted: 'graceful_degrade' },
};

export function getLlmStagePolicy(stage: LlmStage): LlmStagePolicy {
  return POLICIES[stage];
}
