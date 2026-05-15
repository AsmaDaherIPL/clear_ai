/**
 * Re-export barrel for backward compatibility (PR 13).
 *
 * All canonical types have moved to src/modules/pipeline/types.ts.
 * This file exists so tests and internal v2/ modules that haven't been
 * updated yet continue to resolve. Remove once all imports are updated.
 */
export * from '../types.js';
