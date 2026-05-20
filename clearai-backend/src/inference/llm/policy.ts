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
  // Pipeline-rewrite — merchant_resolution disambiguation. Tightened
  // 2026-05-16 after batch 019e3103 showed p95=50s, max=67s on the
  // merchant_resolution stage — single largest contributor to batch
  // wall-time (34.5% of summed LLM latency). The old policy
  // (maxAttempts: 3, timeoutMs: 10000, totalBudget: 30000) inherited
  // the legacy code_resolver shape but merchant_resolution is NOT the
  // critical path — when it gives up the orchestrator falls back to
  // identify-derived retrieval anyway. Better to cap fast and let the
  // pipeline route through identify than to burn 50s per p95 row.
  // 2 attempts × 8s = 16s worst case, 12s total budget enforced.
  merchant_replacement_pick: { stage: 'merchant_replacement_pick', maxAttempts: 2, timeoutMs: 8000,  retryOnParseFailure: true,  totalBudgetMs: 12000, onExhausted: 'graceful_degrade' },
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
  // Pipeline-rewrite — final picker. 30s per attempt (was 15s, raised
  // 2026-05-20 after pilot row #8 "Dresses" hit a hard 30s pick on rev
  // 0000160: identify=3.2s + pick=30s timeout → ZERO_SIGNAL). Foundry
  // latency for picker calls today shows p50≈9s, p90≈14s, p99≈30s on
  // multi-candidate prompts; the previous 15s ceiling was triggering
  // for the long tail (~5-10% of rows). 3 attempts × 30s = 90s total
  // budget; this is still below the dispatch wall of ~120s.
  pick:                      { stage: 'pick',                      maxAttempts: 3, timeoutMs: 30000, retryOnParseFailure: true,  totalBudgetMs: 90000, onExhausted: 'graceful_degrade' },
};

export function getLlmStagePolicy(stage: LlmStage): LlmStagePolicy {
  return POLICIES[stage];
}
