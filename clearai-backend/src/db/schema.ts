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

export { batches } from './schema/batches.js';
export type {
  BatchRow,
  NewBatchRow,
  BatchMode,
  BatchStatus,
  ClassificationStatus,
  DeclarationStatus,
} from './schema/batches.js';

export { batchItems } from './schema/batch-items.js';
export type {
  BatchItemRow,
  NewBatchItemRow,
  BatchItemStatus,
} from './schema/batch-items.js';

export { batchFilings } from './schema/batch-filings.js';
export type {
  BatchFilingRow,
  NewBatchFilingRow,
  BundleStrategy,
  FilingStatus,
  FilingZatcaStatus,
} from './schema/batch-filings.js';

export { manifests } from './schema/manifests.js';
export type {
  ManifestRow,
  NewManifestRow,
} from './schema/manifests.js';

export { awbs } from './schema/awbs.js';
export type {
  AwbRow,
  NewAwbRow,
} from './schema/awbs.js';

export { filingAwbs } from './schema/filing-awbs.js';
export type {
  FilingAwbRow,
  NewFilingAwbRow,
} from './schema/filing-awbs.js';

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
