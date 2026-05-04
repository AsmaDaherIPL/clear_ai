// Owner: BatchPlumber agent.
// Phase 1 result types — what the classification phase produces per item.
// Expected exports:
//   ClassificationOutcome     'succeeded' | 'flagged' | 'blocked' | 'failed'
//   ItemClassificationResult  { itemId, finalCode, sanityVerdict, trace, error? }
//   PhaseClassificationSummary  { total, succeeded, flagged, blocked, failed, durationMs }

export {};
