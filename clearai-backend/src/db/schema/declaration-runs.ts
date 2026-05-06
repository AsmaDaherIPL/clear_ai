/**
 * declaration_runs — one row per uploaded commercial-invoice file (or one
 * API submission). Each set produces N rendered ZATCA declarations.
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
 *   • tenants                — FK target (operator -> operators.slug)
 *   • declaration_run_items  — child rows (FK ON DELETE CASCADE)
 *   • declarations           — Phase 5; rendered XML bundles (FK ON DELETE CASCADE)
 */
import { pgTable, uuid, varchar, text, integer, jsonb, timestamp, foreignKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { operators } from './operators.js';

/** Mirror of declaration_runs_mode_chk. */
export type DeclarationRunMode = 'classify_only' | 'classify_and_declare';

/** Mirror of declaration_runs_status_chk. */
export type DeclarationRunStatus =
  | 'pending'
  | 'ingesting'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Mirror of declaration_runs_classification_status_chk. */
export type ClassificationStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Mirror of declaration_runs_declaration_status_chk. NULL when mode='classify_only'. */
export type DeclarationStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export const declarationRuns = pgTable(
  'declaration_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning operator_slug. FK -> operators(slug) ON DELETE RESTRICT. */
    operatorSlug: varchar('operator_slug', { length: 32 }).notNull(),

    /** Two-phase mode; CHECK-locked. */
    mode: varchar('mode', { length: 32 }).notNull().default('classify_and_declare').$type<DeclarationRunMode>(),

    /** Derived overall lifecycle; CHECK-locked. Materialised for cheap polling. */
    status: varchar('status', { length: 32 }).notNull().default('pending').$type<DeclarationRunStatus>(),

    /** Phase 1 lifecycle; CHECK-locked. Always non-null. */
    classificationStatus: varchar('classification_status', { length: 32 })
      .notNull()
      .default('pending')
      .$type<ClassificationStatus>(),

    /**
     * Phase 2 lifecycle; CHECK-locked. Nullable because mode='classify_only'
     * sets have no Phase 2 (enforced by declaration_runs_mode_declaration_consistency_chk).
     */
    declarationStatus: varchar('declaration_status', { length: 32 }).$type<DeclarationStatus>(),

    /** Blob key of the uploaded source file (under BATCH_BLOB_CONTAINER). */
    sourceBlobKey: text('source_blob_key').notNull(),

    /** Blob key of the rendered result (XML or JSON). NULL until Phase 2 lands. */
    resultBlobKey: text('result_blob_key'),

    /** Parsed row count after canonicalisation. */
    rowCount: integer('row_count').notNull(),

    /** Caller-supplied metadata (callback url, original filename, etc.). Object-typed by CHECK. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),

    /** Last failure message (truncated by app layer). NULL on success. */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Auto-bumped by declaration_runs_touch_updated_at_trg. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    operatorSlugFk: foreignKey({
      name: 'declaration_runs_operator_slug_fk',
      columns: [t.operatorSlug],
      foreignColumns: [operators.slug],
    }).onDelete('restrict'),

    operatorSlugIdx: index('declaration_runs_operator_slug_idx').on(t.operatorSlug),
    createdAtIdx: index('declaration_runs_created_at_idx').on(t.createdAt.desc()),
  }),
);

export type DeclarationRunRow = typeof declarationRuns.$inferSelect;
export type NewDeclarationRunRow = typeof declarationRuns.$inferInsert;
