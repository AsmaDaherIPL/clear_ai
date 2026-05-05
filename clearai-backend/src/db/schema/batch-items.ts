/**
 * batch_items — one row per parsed line item under a batch.
 *
 * Phase 1 (classification) flow:
 *   pending -> claimNextItem() -> classifying
 *           -> dispatch(item)
 *           -> succeeded | flagged | blocked | failed (terminal)
 *
 * Two sibling jsonb columns:
 *   • `canonical` — mapper-output `CanonicalLineItem` (no PII, no source row)
 *   • `raw_row`   — verbatim parsed source row (PII; column-level GRANT excludes
 *                   raw_row from the analytics role per migration 0043)
 *
 * `final_code` is promoted to a top-level column (not just inside the
 * classification_result jsonb) so it can FK to zatca_hs_codes(code) ON
 * DELETE RESTRICT — a SABER deletion of a code that's been used in a
 * classification fails loudly rather than silently orphaning the result.
 *
 * Related tables:
 *   • batches         — FK target (batch_id -> batches.id) ON DELETE CASCADE
 *   • zatca_hs_codes  — FK target (final_code -> zatca_hs_codes.code) ON DELETE RESTRICT
 */
import { pgTable, uuid, integer, varchar, char, jsonb, text, timestamp, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { batches } from './batches.js';
import { hsCodes } from './zatca-hs-codes.js';
import type { CanonicalLineItem, RawRow } from '../../modules/tenants/tenant-config.types.js';

/** Mirror of batch_items_status_chk. */
export type BatchItemStatus =
  | 'pending'
  | 'classifying'
  | 'succeeded'
  | 'flagged'
  | 'blocked'
  | 'failed';

export const batchItems = pgTable(
  'batch_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Parent batch. FK -> batches(id) ON DELETE CASCADE. */
    batchId: uuid('batch_id').notNull(),

    /** 1-based row position from the source file (post-header). */
    rowIndex: integer('row_index').notNull(),

    /** Mapper-output CanonicalLineItem. Object-typed by CHECK. No PII. */
    canonical: jsonb('canonical').notNull().$type<CanonicalLineItem>(),

    /**
     * Verbatim parsed source row. Carries PII; the migration grants only the
     * application role full SELECT on this column.
     */
    rawRow: jsonb('raw_row').notNull().$type<RawRow>(),

    /** Phase 1 lifecycle; CHECK-locked. */
    status: varchar('status', { length: 32 }).notNull().default('pending').$type<BatchItemStatus>(),

    /**
     * Final 12-digit ZATCA HS code from dispatch().finalCode. NULL until the
     * item reaches 'succeeded' or 'flagged' — enforced by
     * batch_items_final_code_status_consistency_chk.
     * FK -> zatca_hs_codes(code) ON DELETE RESTRICT.
     */
    finalCode: char('final_code', { length: 12 }),

    /** Full dispatch() result payload (path, alternates, signals). Opaque jsonb. */
    classificationResult: jsonb('classification_result').$type<Record<string, unknown>>(),

    /** ItemTrace from dispatch(). Object-typed by CHECK. */
    trace: jsonb('trace').$type<Record<string, unknown>>(),

    /** Last failure message. NULL on success. */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Auto-bumped by batch_items_touch_updated_at_trg. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchFk: foreignKey({
      name: 'batch_items_batch_fk',
      columns: [t.batchId],
      foreignColumns: [batches.id],
    }).onDelete('cascade'),

    finalCodeFk: foreignKey({
      name: 'batch_items_final_code_fk',
      columns: [t.finalCode],
      foreignColumns: [hsCodes.code],
    }).onDelete('restrict'),

    batchRowUniq: unique('batch_items_batch_row_uniq').on(t.batchId, t.rowIndex),

    /**
     * Composite (batch_id, row_index) index. Covers WHERE batch_id = $1
     * lookups via leftmost-prefix AND satisfies ORDER BY row_index without
     * an in-memory sort. Replaces the prior single-column (batch_id) index.
     */
    batchRowIdx: index('batch_items_batch_row_idx').on(t.batchId, t.rowIndex),
  }),
);

export type BatchItemRow = typeof batchItems.$inferSelect;
export type NewBatchItemRow = typeof batchItems.$inferInsert;
