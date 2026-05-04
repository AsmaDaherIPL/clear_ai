// Owner: BatchPlumber agent.
// Phase 1 of every batch — runs ALWAYS, regardless of mode.
//
// Drives the dispatch pipeline (modules/dispatch/dispatch.use-case.ts) over
// every pending item in the batch, using a p-limit semaphore so concurrency
// is bounded by env.BATCH_LLM_CONCURRENCY.
//
// Per item:
//   1. mark item status='classifying'
//   2. await dispatch(canonicalLineItem)
//   3. write classification_result + trace + status ∈ {'succeeded','flagged','blocked','failed'}
//
// When all items terminal:
//   - update batches.classification_status='completed'
//   - return PhaseClassificationSummary
//
// CRITICAL: this service does NOT touch ZATCA, XML, or blob storage.
//           Phase 2 (declaration) is a separate concern.

export {};
