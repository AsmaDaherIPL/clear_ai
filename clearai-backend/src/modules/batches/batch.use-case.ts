// Owner: BatchPlumber agent. See tracker/AGENT_BRIEFS/batch-plumber.md
// Purpose: orchestrates parse -> persist -> dispatch -> finalize for a batch.
// Calls: tenants registry, csv/xlsx parsers, dispatch.use-case (per item),
//        declarations.service for ZATCA XML generation, blob storage.

export {};
