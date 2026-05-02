/** Aggregator — re-exports every per-table schema from ./schemas/. */
export { hsCodes } from './schemas/zatca-hs-codes.js';
export type { HsCodeRow, NewHsCodeRow } from './schemas/zatca-hs-codes.js';

export { hsCodeDisplay } from './schemas/zatca-hs-code-display.js';
export type {
  HsCodeDisplayRow,
  NewHsCodeDisplayRow,
} from './schemas/zatca-hs-code-display.js';

export { hsCodeSearch } from './schemas/zatca-hs-code-search.js';
export type {
  HsCodeSearchRow,
  NewHsCodeSearchRow,
} from './schemas/zatca-hs-code-search.js';

export { tenantCodeOverrides } from './schemas/tenant-code-overrides.js';
export type {
  TenantCodeOverride,
  NewTenantCodeOverride,
} from './schemas/tenant-code-overrides.js';

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
