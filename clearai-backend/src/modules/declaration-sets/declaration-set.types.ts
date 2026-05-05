/**
 * Declaration-set domain DTOs.
 *
 * Status enums are re-exported from the schema layer so the union types
 * stay in lock-step with the DB CHECK constraints (rule 6).
 */
export type {
  DeclarationSetMode,
  DeclarationSetStatus,
  ClassificationStatus,
  DeclarationStatus,
  DeclarationSetItemStatus,
} from '../../db/schema.js';

import type {
  ClassificationStatus,
  DeclarationStatus,
  DeclarationSetItemStatus,
  DeclarationSetMode,
  DeclarationSetStatus,
} from '../../db/schema.js';

export interface DeclarationSetSummary {
  id: string;
  tenant_slug: string;
  mode: DeclarationSetMode;
  status: DeclarationSetStatus;
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

export interface DeclarationSetItemRecord {
  id: string;
  declaration_set_id: string;
  row_index: number;
  status: DeclarationSetItemStatus;
  final_code: string | null;
  classification_result: Record<string, unknown> | null;
  trace: Record<string, unknown> | null;
  error: string | null;
}
