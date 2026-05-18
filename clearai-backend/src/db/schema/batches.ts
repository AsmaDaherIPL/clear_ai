/**
 * batches — one row per uploaded commercial-invoice file (or one
 * API submission). Each batch produces N rendered ZATCA declarations.
 *
 * Renamed from declaration_runs in migration 0084 (PR1) to align the DB
 * surface with the user-facing API (`/batches`) and SPA vocabulary, and
 * to avoid collision with the new ZATCA "declaration" entity (NQD per
 * AWB) introduced in PR2.
 *
 * Two-phase model:
 *   • mode 'classify_and_declare' (default) runs Phase 1 (classification) +
 *     Phase 2 (declaration).
 *   • mode 'classify_only' runs Phase 1 only; declaration_status is NULL.
 *
 * The four status enums (mode, status, classification_status,
 * declaration_status) are CHECK-locked at the DB. When you add a TS-side
 * value, ALTER the CHECK in a new migration.
 *
 * Related tables:
 *   • operators       — FK target (operator_id -> operators.id)
 *   • batch_items     — child rows (FK ON DELETE CASCADE)
 *   • batch_filings   — Phase 5; rendered XML bundles (FK ON DELETE CASCADE)
 */
import { pgTable, uuid, varchar, text, integer, jsonb, timestamp, foreignKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { operators } from './operators.js';

/** Mirror of batches_mode_chk. */
export type BatchMode = 'classify_only' | 'classify_and_declare';

/** Mirror of batches_status_chk. */
export type BatchStatus =
  | 'pending'
  | 'ingesting'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Mirror of batches_classification_status_chk. */
export type ClassificationStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Mirror of batches_declaration_status_chk. NULL when mode='classify_only'. */
export type DeclarationStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export const batches = pgTable(
  'batches',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning operator id. FK -> operators(id) ON DELETE RESTRICT. */
    operatorId: uuid('operator_id').notNull(),

    /** Two-phase mode; CHECK-locked. */
    mode: varchar('mode', { length: 32 }).notNull().default('classify_and_declare').$type<BatchMode>(),

    /** Derived overall lifecycle; CHECK-locked. Materialised for cheap polling. */
    status: varchar('status', { length: 32 }).notNull().default('pending').$type<BatchStatus>(),

    /** Phase 1 lifecycle; CHECK-locked. Always non-null. */
    classificationStatus: varchar('classification_status', { length: 32 })
      .notNull()
      .default('pending')
      .$type<ClassificationStatus>(),

    /**
     * Phase 2 lifecycle; CHECK-locked. Nullable because mode='classify_only'
     * batches have no Phase 2 (enforced by batches_mode_declaration_consistency_chk).
     */
    declarationStatus: varchar('declaration_status', { length: 32 }).$type<DeclarationStatus>(),

    /** Blob key of the uploaded source file (under BATCH_BLOB_CONTAINER). */
    sourceBlobKey: text('source_blob_key').notNull(),

    /** Blob key of the rendered result (XML or JSON). NULL until Phase 2 lands. */
    resultBlobKey: text('result_blob_key'),

    /**
     * Tree-layout prefix for the rendered HV/LV XMLs + run-index.json,
     * e.g. "naqel/2026/05/08/<batch_id>". Locked in at batch creation time
     * so the read path doesn't have to recompute date partitions from
     * created_at (timezone-safe). NULL on legacy rows that pre-date
     * migration 0061. The blob path string keeps the legacy
     * "declaration-runs" prefix; only the in-DB id label changed.
     */
    blobPrefix: text('blob_prefix'),

    /** Parsed row count after canonicalisation. */
    rowCount: integer('row_count').notNull(),

    /** Caller-supplied metadata (callback url, original filename, etc.). Object-typed by CHECK. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),

    /** Last failure message (truncated by app layer). NULL on success. */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Auto-bumped by batches_touch_updated_at_trg. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    operatorIdFk: foreignKey({
      name: 'batches_operator_id_fk',
      columns: [t.operatorId],
      foreignColumns: [operators.id],
    }).onDelete('restrict'),

    operatorIdIdx: index('batches_operator_id_idx').on(t.operatorId),
    createdAtIdx: index('batches_created_at_idx').on(t.createdAt.desc()),
  }),
);

export type BatchRow = typeof batches.$inferSelect;
export type NewBatchRow = typeof batches.$inferInsert;
