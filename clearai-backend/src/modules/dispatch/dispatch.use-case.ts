// Owner: dispatch-flow agent.
// The full v2 5-stage pipeline orchestrator:
//   Stage 0+1  dispatch-input-normalizer  (signal: merchant_code_status)
//   Stage 2A   blind classify             (calls hs-classification/classify)
//   Stage 2B   reconciliation             (5 paths: agree/arbitrate/investigate/expand/accept)
//   Stage 3    tenant override            (DB lookup, no LLM)
//   Stage 4    sanity check               (LLM call — fraud catcher)
// Returns: { final_code, sanity_verdict, trace } per item.
// CALLED BY: batch.use-case (per item, with concurrency wrapper).

export {};
