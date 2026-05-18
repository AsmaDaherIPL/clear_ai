/**
 * batch_filings — one row per rendered ZATCA Declaration bundle.
 *
 * Renamed from declaration_run_filings in migration 0084 (PR1). The parent
 * FK column `declaration_run_id` was renamed to `batch_id` in the same
 * migration. Semantics are unchanged.
 *
 * Inserted by Phase 2 (modules/batches/filings/). HV bundles
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
 *   • batches    — FK target (batch_id -> batches.id) ON DELETE CASCADE
 *   • manifests  — FK target (manifest_id -> manifests.id) ON DELETE SET NULL  (added PR2, NULLABLE)
 */
import { pgTable, uuid, integer, text, timestamp, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { batches } from './batches.js';
import { manifests } from './manifests.js';

export type BundleStrategy = 'HV_STANDALONE' | 'LV_BUNDLED';

/** Mirror of batch_filings_status_chk. */
export type FilingStatus = 'pending' | 'generated' | 'failed';

/** Mirror of batch_filings_zatca_status_chk. */
export type FilingZatcaStatus = 'accepted' | 'rejected';

export const batchFilings = pgTable(
  'batch_filings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Parent batch. FK -> batches(id) ON DELETE CASCADE. */
    batchId: uuid('batch_id').notNull(),
    /**
     * Parent manifest. FK -> manifests(id) ON DELETE SET NULL. NULLABLE:
     * legacy filings carry NULL until PR3's bundler sets it. ON DELETE
     * SET NULL preserves the filing's audit record (blob_key, status,
     * bayan_no) even if the manifest is purged.
     */
    manifestId: uuid('manifest_id'),
    /** 0-based ordinal within the batch's render order. */
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
    batchFk: foreignKey({
      name: 'batch_filings_batch_id_fk',
      columns: [t.batchId],
      foreignColumns: [batches.id],
    }).onDelete('cascade'),

    manifestFk: foreignKey({
      name: 'batch_filings_manifest_id_fk',
      columns: [t.manifestId],
      foreignColumns: [manifests.id],
    }).onDelete('set null'),

    batchBundleUniq: unique('batch_filings_batch_bundle_uniq').on(t.batchId, t.bundleIndex),

    batchIdx: index('batch_filings_batch_idx').on(t.batchId),
    statusIdx: index('batch_filings_status_idx').on(t.status),
    manifestIdx: index('batch_filings_manifest_id_idx')
      .on(t.manifestId)
      .where(sql`${t.manifestId} IS NOT NULL`),
  }),
);

export type BatchFilingRow = typeof batchFilings.$inferSelect;
export type NewBatchFilingRow = typeof batchFilings.$inferInsert;
