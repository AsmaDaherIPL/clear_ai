// Owner: BatchPlumber agent. See tracker/AGENT_BRIEFS/batch-plumber.md
// Endpoints:
//   POST   /batches                         — multipart upload, returns 202 + poll url
//   GET    /batches/:id                     — BatchSummary
//   GET    /batches/:id/items               — paginated item list with traces
//   GET    /batches/:id/declarations        — ZATCA XML stream (or JSON traces)
//   PATCH  /batches/:id                     — cancel only (status -> cancelled)

export {};
