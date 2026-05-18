/**
 * Dispatch contract — the shape Phase 1 of the batch pipeline
 * depends on.
 *
 * Owned conceptually by the dispatch-flow agent; mirrored here so the
 * batches module can build against a stable interface while
 * modules/dispatch/dispatch.use-case.ts is still a stub.
 *
 * When the dispatch agent ships their real implementation, they should
 * import these types from here (or move them into dispatch.types.ts and
 * re-export from this file for backwards compatibility).
 */
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { DispatchResult } from '../batches/classification/classification.types.js';

export type { DispatchResult } from '../batches/classification/classification.types.js';

export type DispatchFn = (item: CanonicalLineItem) => Promise<DispatchResult>;
