/**
 * Declaration-set domain DTOs.
 *
 * Status enums are re-exported from the schema layer so the union types
 * stay in lock-step with the DB CHECK constraints (rule 6).
 */
export type {
  BatchMode,
  BatchStatus,
  ClassificationStatus,
  DeclarationStatus,
  BatchItemStatus,
} from '../../db/schema.js';

import type {
  ClassificationStatus,
  DeclarationStatus,
  BatchItemStatus,
  BatchMode,
  BatchStatus,
} from '../../db/schema.js';

export interface BatchSummary {
  id: string;
  operator_slug: string;
  mode: BatchMode;
  status: BatchStatus;
  classification_status: ClassificationStatus;
  declaration_status: DeclarationStatus | null;
  row_count: number;
  succeeded: number;
  flagged: number;
  blocked: number;
  failed: number;
  pending: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export interface DeclarationRunItemRecord {
  id: string;
  declaration_run_id: string;
  row_index: number;
  status: BatchItemStatus;
  final_code: string | null;
  classification_result: Record<string, unknown> | null;
  trace: Record<string, unknown> | null;
  error: string | null;
}
