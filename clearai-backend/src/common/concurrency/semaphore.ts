// Owner: BatchPlumber agent (used by all bulk-processing modules).
// Thin p-limit wrapper. Reads BATCH_LLM_CONCURRENCY (or override) from env.
// Exposes:  withSemaphore(limit) -> <T>(fn: () => Promise<T>) => Promise<T>

export {};
