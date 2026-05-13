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

export { fxRates } from './schema/fx-rates.js';
export type { FxRateRow, NewFxRateRow } from './schema/fx-rates.js';

export { classificationEvents } from './schema/classification-events.js';
export type {
  ClassificationEventRow,
  NewClassificationEventRow,
} from './schema/classification-events.js';

export { hitlQueue } from './schema/hitl-queue.js';
export type { HitlQueueRow, NewHitlQueueRow } from './schema/hitl-queue.js';

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

export { operatorLookups } from './schema/operator-lookups.js';
export type { OperatorLookupRow, NewOperatorLookupRow } from './schema/operator-lookups.js';

export { tabadulCodes } from './schema/tabadul-codes.js';
export type { TabadulCodeRow, NewTabadulCodeRow } from './schema/tabadul-codes.js';

export { operatorDeclarationConfig } from './schema/operator-declaration-config.js';
export type {
  OperatorDeclarationConfigRow,
  NewOperatorDeclarationConfigRow,
} from './schema/operator-declaration-config.js';

export { declarationRuns } from './schema/declaration-runs.js';
export type {
  DeclarationRunRow,
  NewDeclarationRunRow,
  BatchMode,
  BatchStatus,
  ClassificationStatus,
  DeclarationStatus,
} from './schema/declaration-runs.js';

export { declarationRunItems } from './schema/declaration-run-items.js';
export type {
  BatchItemRow,
  NewDeclarationRunItemRow,
  BatchItemStatus,
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

export { llmCallMetrics } from './schema/llm-call-metrics.js';
export type {
  LlmCallMetricRow,
  NewLlmCallMetricRow,
  LlmOutcomeClass,
} from './schema/llm-call-metrics.js';
