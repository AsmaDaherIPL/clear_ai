// Owner: BatchPlumber agent.
// Drizzle queries scoped to phase 2:
//   - listClassifiedItems(batchId)         hydrate items with succeeded|flagged status
//   - recordDeclaration(batchId, blobRef)  one row per bundle in the declarations table
//   - markBatchPhase(batchId, status)      bump batches.declaration_status

export {};
