/**
 * declaration_run_filings — one row per rendered ZATCA Declaration bundle.
 *
 * Inserted by Phase 2 (modules/declaration-runs/filings/). HV bundles
 * hold exactly one item; LV bundles up to operator.bundle_size.
 *
 * Two independent status columns:
 *   • status        — ClearAI's pipeline state: 'pending' | 'generated' | 'failed'.
 *                     The render pipeline owns this column.
 *   • zatca_status  — ZATCA's verdict: NULL | 'accepted' | 'rejected'.
 *                     Stays NULL until the filing has been submitted and
 *                     ZATCA has responded.
 *
 * Cross-column consistency CHECK guarantees:
 *   • zatca_status='accepted'  ⇒ bayan_no NOT NULL, rejection_reason NULL
 *   • zatca_status='rejected'  ⇒ bayan_no NULL, rejection_reason NOT NULL
 *   • zatca_status NULL        ⇒ both NULL
 *
 * Related tables:
 *   • declaration_runs — FK target (declaration_run_id -> declaration_runs.id) ON DELETE CASCADE
 */
import { pgTable, uuid, integer, text, timestamp, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { declarationRuns } from './declaration-runs.js';

export type BundleStrategy = 'HV_STANDALONE' | 'LV_BUNDLED';

/** Mirror of declaration_run_filings_status_chk. */
export type FilingStatus = 'pending' | 'generated' | 'failed';

/** Mirror of declaration_run_filings_zatca_status_chk. */
export type FilingZatcaStatus = 'accepted' | 'rejected';

export const declarationRunFilings = pgTable(
  'declaration_run_filings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Parent declaration_run. FK -> declaration_runs(id) ON DELETE CASCADE. */
    declarationRunId: uuid('declaration_run_id').notNull(),
    /** 0-based ordinal within the run's render order. */
    bundleIndex: integer('bundle_index').notNull(),
    /** CHECK-locked closed enum. */
    bundleStrategy: text('bundle_strategy').notNull().$type<BundleStrategy>(),
    /** HV_STANDALONE = 1; LV_BUNDLED in [1, operator.bundle_size]. */
    itemCount: integer('item_count').notNull(),
    /** Blob key (under BATCH_BLOB_CONTAINER). */
    blobKey: text('blob_key').notNull(),

    /** ClearAI pipeline state; CHECK-locked. Defaults to 'pending'. */
    status: text('status').notNull().default('pending').$type<FilingStatus>(),

    /**
     * ZATCA verdict; CHECK-locked. NULL until ZATCA has responded.
     * 'accepted' requires bayan_no; 'rejected' requires rejection_reason
     * (cross-column CHECK enforces this).
     */
    zatcaStatus: text('zatca_status').$type<FilingZatcaStatus>(),

    /** Carrier's submission receipt id. NULL unless zatca_status='accepted'. */
    bayanNo: text('bayan_no'),
    /** ZATCA error reason. NULL unless zatca_status='rejected'. */
    rejectionReason: text('rejection_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the filing is handed off for ZATCA submission. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** Set when ZATCA returns a verdict (accepted or rejected). */
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => ({
    runFk: foreignKey({
      name: 'declaration_run_filings_run_fk',
      columns: [t.declarationRunId],
      foreignColumns: [declarationRuns.id],
    }).onDelete('cascade'),

    runBundleUniq: unique('declaration_run_filings_run_bundle_uniq').on(t.declarationRunId, t.bundleIndex),

    runIdx: index('declaration_run_filings_run_idx').on(t.declarationRunId),
    statusIdx: index('declaration_run_filings_status_idx').on(t.status),
  }),
);

export type DeclarationRunFilingRow = typeof declarationRunFilings.$inferSelect;
export type NewDeclarationRunFilingRow = typeof declarationRunFilings.$inferInsert;

/** Legacy aliases for files still importing under the old name. */
export type DeclarationRow = DeclarationRunFilingRow;
export type NewDeclarationRow = NewDeclarationRunFilingRow;
