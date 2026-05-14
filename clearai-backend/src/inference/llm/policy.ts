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
  | 'sanity'
  // PR-A-2: anchored-pipeline identify stage (web-tool-enabled).
  // Lands here alongside the legacy stages so a single LlmStage union
  // covers both architectures during the migration window. Removed
  // alongside the legacy stages in PR-A-8 cleanup (the legacy stages
  // are deleted but `identify` survives as the anchored pipeline's
  // entry point).
  | 'identify';

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
  // PR-A-2: anchored-pipeline identify. Web-tool-enabled — same timing
  // shape as researcher_web (1 attempt, 30s, web latency dominates;
  // the circuit breaker handles repeated transport failures).
  identify:               { stage: 'identify',               maxAttempts: 1, timeoutMs: 30000, retryOnParseFailure: false, totalBudgetMs: 30000, onExhausted: 'graceful_degrade' },
};

export function getLlmStagePolicy(stage: LlmStage): LlmStagePolicy {
  return POLICIES[stage];
}
