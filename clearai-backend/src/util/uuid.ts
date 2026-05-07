/**
 * Backwards-compat shim. The canonical location is src/common/utils/uuid.ts;
 * this re-export keeps the legacy import path working for ingest scripts and
 * schema files that haven't been updated yet. Safe to keep indefinitely or
 * to fold back into a single sweep when convenient.
 */
export * from '../common/utils/uuid.js';
