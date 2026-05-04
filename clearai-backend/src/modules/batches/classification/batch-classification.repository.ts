// Owner: BatchPlumber agent.
// Drizzle queries scoped to phase 1 mutations on batch_items:
//   - claimNextItem(batchId)            transition pending -> classifying (with row-level lock)
//   - recordItemResult(itemId, result)  store classification_result + trace + status
//   - markBatchPhase(batchId, status)   bump batches.classification_status

export {};
