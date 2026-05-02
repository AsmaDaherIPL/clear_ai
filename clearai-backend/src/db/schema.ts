/** Aggregator — re-exports every per-table schema from ./schemas/. */
export { hsCodes } from './schemas/zatca-hs-codes.js';
export type { HsCodeRow, NewHsCodeRow } from './schemas/zatca-hs-codes.js';

export { setupMeta } from './schemas/setup-meta.js';
export type { SetupMetaRow } from './schemas/setup-meta.js';

export { classificationEvents } from './schemas/classification-events.js';
export type {
  ClassificationEventRow,
  NewClassificationEventRow,
} from './schemas/classification-events.js';

export { procedureCodes } from './schemas/zatca-procedure-codes.js';
export type {
  ProcedureCodeRow,
  NewProcedureCodeRow,
} from './schemas/zatca-procedure-codes.js';
