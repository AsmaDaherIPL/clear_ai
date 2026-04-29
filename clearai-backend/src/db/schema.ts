/**
 * Aggregator — re-exports all per-table schemas so that:
 *   - `drizzle.config.ts` (pointing at this file) sees every table.
 *   - `drizzle(pool, { schema })` in `client.ts` gets all relations.
 *   - Application code can `import { hsCodes, ... } from '../db/schema.js'`
 *     without changing call sites after the split.
 *
 * Per-table definitions live in `./schemas/*.ts`.
 */
export { hsCodes } from './schemas/hs-codes.js';
export type { HsCodeRow, NewHsCodeRow } from './schemas/hs-codes.js';

export { setupMeta } from './schemas/setup-meta.js';
export type { SetupMetaRow } from './schemas/setup-meta.js';

export { classificationEvents } from './schemas/classification-events.js';
export type {
  ClassificationEventRow,
  NewClassificationEventRow,
} from './schemas/classification-events.js';

export { procedureCodes } from './schemas/procedure-codes.js';
export type {
  ProcedureCodeRow,
  NewProcedureCodeRow,
} from './schemas/procedure-codes.js';
