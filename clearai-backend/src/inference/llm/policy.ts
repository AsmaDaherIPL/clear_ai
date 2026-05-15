/**
 * Typed per-stage retry / timeout policy for LLM-backed pipeline stages.
 *
 * Hardcoded registry: type-safe, deploy to change, no runtime config lookup.
 * Promotion to env-driven config is deferred until incident response needs it.
 */

export type LlmStage =
  // Submission_description: short Arabic rewrite for the ZATCA envelope.
  // Cheaper model, 3 attempts, 8s timeout per attempt.
  | 'submission_description'
  // Sanity: final value-plausibility check on the picked code + amount.
  // Cheap model, 3 attempts, 6s.
  | 'sanity'
  // Multi-replacement disambiguation when a deleted code has N>1
  // replacement codes, and the prefix-walk leaf pick when a partial
  // merchant prefix has N>1 children. Both are small picker-style LLM
  // calls used by merchant_resolution.
  | 'merchant_replacement_pick'
  // Pipeline rewrite — fast-pass identify, Sonnet WITHOUT web_search.
  // Cheaper + faster (no web latency) for rows the model can resolve
  // from training alone. Rows the fast pass gives up on
  // (uninformative+genuine, multi_product) trigger the
  // 'identify_web_fallback' stage.
  | 'identify_fast'
  // Pipeline rewrite — web-search-enabled fallback identify. Sonnet +
  // web_search, single attempt, 30s timeout, no parse-retry. Only
  // invoked when identify_fast couldn't commit.
  | 'identify_web_fallback'
  // Pipeline rewrite — final picker over the multi-arm candidate set
  // (top 8 after rerank). Sonnet, parse retries enabled because the
  // structured-output prompt is non-trivial.
  | 'pick';

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
  submission_description:    { stage: 'submission_description',    maxAttempts: 3, timeoutMs: 8000,  retryOnParseFailure: true,  totalBudgetMs: 25000, onExhausted: 'graceful_degrade' },
  sanity:                    { stage: 'sanity',                    maxAttempts: 3, timeoutMs: 6000,  retryOnParseFailure: true,  totalBudgetMs: 20000, onExhausted: 'graceful_degrade' },
  // Pipeline-rewrite — merchant_resolution disambiguation. Inherits the
  // legacy code_resolver shape (3 attempts, 10s) — same operation; the
  // candidate set is the codebook's replacement list or prefix-walk
  // children, not a retrieval result.
  merchant_replacement_pick: { stage: 'merchant_replacement_pick', maxAttempts: 3, timeoutMs: 10000, retryOnParseFailure: true,  totalBudgetMs: 30000, onExhausted: 'graceful_degrade' },
  // Pipeline-rewrite — fast-pass identify. No web tool, so no search
  // round-trip; latency is bounded by Sonnet's own generation time.
  // Single attempt + no parse-retry — if the fast pass fails parsing,
  // fall through to web fallback which gets to try again with a
  // different (search-enabled) prompt.
  identify_fast:             { stage: 'identify_fast',             maxAttempts: 1, timeoutMs: 15000, retryOnParseFailure: false, totalBudgetMs: 15000, onExhausted: 'graceful_degrade' },
  // Pipeline-rewrite — web-search fallback identify. Web latency
  // dominates, so we give it a single 30s attempt; the circuit breaker
  // handles sustained failures.
  identify_web_fallback:     { stage: 'identify_web_fallback',     maxAttempts: 1, timeoutMs: 30000, retryOnParseFailure: false, totalBudgetMs: 30000, onExhausted: 'graceful_degrade' },
  // Pipeline-rewrite — final picker. 15s per attempt headroom because
  // a multi-candidate prompt under Foundry load can hit the 10s wall on
  // first-byte while at quota. 3 attempts × 15s = 50s total budget.
  pick:                      { stage: 'pick',                      maxAttempts: 3, timeoutMs: 15000, retryOnParseFailure: true,  totalBudgetMs: 50000, onExhausted: 'graceful_degrade' },
};

export function getLlmStagePolicy(stage: LlmStage): LlmStagePolicy {
  return POLICIES[stage];
}
