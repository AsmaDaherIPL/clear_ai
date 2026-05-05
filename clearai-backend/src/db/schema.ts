/** Aggregator — re-exports every per-table schema from ./schemas/. */
export { hsCodes } from './schema/zatca-hs-codes.js';
export type { HsCodeRow, NewHsCodeRow } from './schema/zatca-hs-codes.js';

export { hsCodeDisplay } from './schema/zatca-hs-code-display.js';
export type {
  HsCodeDisplayRow,
  NewHsCodeDisplayRow,
} from './schema/zatca-hs-code-display.js';

export { hsCodeSearch } from './schema/zatca-hs-code-search.js';
export type {
  HsCodeSearchRow,
  NewHsCodeSearchRow,
} from './schema/zatca-hs-code-search.js';

export { tenantCodeOverrides } from './schema/tenant-code-overrides.js';
export type {
  TenantCodeOverride,
  NewTenantCodeOverride,
} from './schema/tenant-code-overrides.js';

export { setupMeta } from './schema/setup-meta.js';
export type { SetupMetaRow } from './schema/setup-meta.js';

export { classificationEvents } from './schema/classification-events.js';
export type {
  ClassificationEventRow,
  NewClassificationEventRow,
} from './schema/classification-events.js';

export { procedureCodes } from './schema/zatca-procedure-codes.js';
export type {
  ProcedureCodeRow,
  NewProcedureCodeRow,
} from './schema/zatca-procedure-codes.js';

// ─── BatchPlumber: tenants registry + batch processing tables ────────────────

export { tenants } from './schema/tenants.js';
export type { TenantRow, NewTenantRow } from './schema/tenants.js';

export { tenantFieldMappings } from './schema/tenant-field-mappings.js';
export type {
  TenantFieldMappingRow,
  NewTenantFieldMappingRow,
} from './schema/tenant-field-mappings.js';

export { tenantConstants } from './schema/tenant-constants.js';
export type {
  TenantConstantRow,
  NewTenantConstantRow,
} from './schema/tenant-constants.js';

export { tenantLookups } from './schema/tenant-lookups.js';
export type { TenantLookupRow, NewTenantLookupRow } from './schema/tenant-lookups.js';

export { declarationSets } from './schema/declaration-sets.js';
export type {
  DeclarationSetRow,
  NewDeclarationSetRow,
  DeclarationSetMode,
  DeclarationSetStatus,
  ClassificationStatus,
  DeclarationStatus,
} from './schema/declaration-sets.js';

export { declarationSetItems } from './schema/declaration-set-items.js';
export type {
  DeclarationSetItemRow,
  NewDeclarationSetItemRow,
  DeclarationSetItemStatus,
} from './schema/declaration-set-items.js';

export { declarations } from './schema/declarations.js';
export type { DeclarationRow, NewDeclarationRow, BundleStrategy } from './schema/declarations.js';
