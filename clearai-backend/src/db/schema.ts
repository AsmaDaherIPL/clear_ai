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

export { operatorCodeOverrides } from './schema/operator-code-overrides.js';
export type {
  OperatorCodeOverrideRow,
  NewOperatorCodeOverrideRow,
} from './schema/operator-code-overrides.js';

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

// ─── BatchPlumber: operators registry + reference data + batch processing tables ────────────

export { operators } from './schema/operators.js';
export type { OperatorRow, NewOperatorRow } from './schema/operators.js';

export { operatorFieldMappings } from './schema/operator-field-mappings.js';
export type {
  OperatorFieldMappingRow,
  NewOperatorFieldMappingRow,
} from './schema/operator-field-mappings.js';

export { operatorConstants } from './schema/operator-constants.js';
export type {
  OperatorConstantRow,
  NewOperatorConstantRow,
} from './schema/operator-constants.js';

export { operatorLookups } from './schema/operator-lookups.js';
export type { OperatorLookupRow, NewOperatorLookupRow } from './schema/operator-lookups.js';

export { tabadulCodes } from './schema/tabadul-codes.js';
export type { TabadulCodeRow, NewTabadulCodeRow } from './schema/tabadul-codes.js';

export { zatcaDeclarationDefaults } from './schema/zatca-declaration-defaults.js';
export type {
  ZatcaDeclarationDefaultRow,
  NewZatcaDeclarationDefaultRow,
} from './schema/zatca-declaration-defaults.js';

export { declarationRuns } from './schema/declaration-runs.js';
export type {
  DeclarationRunRow,
  NewDeclarationRunRow,
  DeclarationRunMode,
  DeclarationRunStatus,
  ClassificationStatus,
  DeclarationStatus,
} from './schema/declaration-runs.js';

export { declarationRunItems } from './schema/declaration-run-items.js';
export type {
  DeclarationRunItemRow,
  NewDeclarationRunItemRow,
  DeclarationRunItemStatus,
} from './schema/declaration-run-items.js';

export { declarationRunFilings } from './schema/declaration-run-filings.js';
export type {
  DeclarationRunFilingRow,
  NewDeclarationRunFilingRow,
  DeclarationRow,
  NewDeclarationRow,
  BundleStrategy,
  FilingStatus,
  FilingZatcaStatus,
} from './schema/declaration-run-filings.js';

export { submissionDescriptions } from './schema/submission-descriptions.js';
export type {
  SubmissionDescriptionRow,
  NewSubmissionDescriptionRow,
} from './schema/submission-descriptions.js';
