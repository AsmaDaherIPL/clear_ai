/**
 * declaration_run_items — one row per parsed line item under a declaration_run.
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
 *   • declaration_runs — FK target (declaration_run_id -> declaration_runs.id) ON DELETE CASCADE
 *   • zatca_hs_codes   — FK target (final_code -> zatca_hs_codes.code) ON DELETE RESTRICT
 */
import { pgTable, uuid, integer, varchar, char, jsonb, text, timestamp, boolean, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { declarationRuns } from './declaration-runs.js';
import { hsCodes } from './zatca-hs-codes.js';
import type { CanonicalLineItem, RawRow } from '../../modules/operators/operator-config.types.js';

/** Mirror of declaration_run_items_status_chk. */
export type BatchItemStatus =
  | 'pending'
  | 'classifying'
  | 'succeeded'
  | 'flagged'
  | 'blocked'
  | 'pending_infra'
  | 'failed';

export const declarationRunItems = pgTable(
  'declaration_run_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Parent declaration_run. FK -> declaration_runs(id) ON DELETE CASCADE. */
    declarationRunId: uuid('declaration_run_id').notNull(),

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
     * declaration_run_items_final_code_status_consistency_chk.
     * FK -> zatca_hs_codes(code) ON DELETE RESTRICT.
     */
    finalCode: char('final_code', { length: 12 }),

    /**
     * Source of `final_code`. Defaults to 'pipeline' for auto-classified
     * rows; updated to 'reviewer_override' when a human reviewer overrides
     * the code via PATCH /classifications/review/:id.
     * See migration 0074.
     */
    finalCodeSource: varchar('final_code_source', { length: 32 })
      .notNull()
      .default('pipeline')
      .$type<'pipeline' | 'reviewer_override'>(),

    /**
     * Captures the pipeline's original `final_code` when a reviewer
     * overrides it. NULL until override happens — at that point we copy
     * the current final_code here, then write the reviewer's code to
     * final_code. Used to audit pipeline-vs-reviewer disagreement rates.
     * See migration 0074.
     */
    pipelineFinalCode: char('pipeline_final_code', { length: 12 }),

    /**
     * Arabic goods description from dispatch().goodsDescriptionAr — feeds
     * `<deccm:goodsDescription>` in the rendered ZATCA Declaration envelope.
     * NULL until the item reaches 'succeeded' or 'flagged' — enforced by
     * declaration_run_items_goods_description_ar_status_consistency_chk.
     */
    goodsDescriptionAr: text('goods_description_ar'),

    /**
     * Reviewer-driven block flag. True when the row was deliberately
     * removed from the ZATCA submission by a human via
     * PATCH /classifications/review/:id with decision='block_from_submission'.
     * The XML builder (when wired) filters WHERE excluded_from_xml = false.
     * Defaults to false; only the review controller flips it true.
     * See migration 0080.
     */
    excludedFromXml: boolean('excluded_from_xml').notNull().default(false),

    /**
     * Discriminator for why the row was blocked. V1 only emits
     * 'reviewer_decision'. NULL when excluded_from_xml = false.
     * See migration 0080.
     */
    blockedReason: varchar('blocked_reason', { length: 64 }),

    /**
     * Wall-clock when the block decision was committed. NULL when
     * excluded_from_xml = false. See migration 0080.
     */
    blockedAt: timestamp('blocked_at', { withTimezone: true }),

    /**
     * Identity of the reviewer who blocked. NULL until user identity is
     * wired (V2 multi-reviewer). See migration 0080.
     */
    blockedBy: text('blocked_by'),

    /** Full dispatch() result payload (path, alternates, signals). Opaque jsonb. */
    classificationResult: jsonb('classification_result').$type<Record<string, unknown>>(),

    /** ItemTrace from dispatch(). Object-typed by CHECK. */
    trace: jsonb('trace').$type<Record<string, unknown>>(),

    /** Last failure message. NULL on success. */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Auto-bumped by declaration_run_items_touch_updated_at_trg. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    setFk: foreignKey({
      name: 'declaration_run_items_set_fk',
      columns: [t.declarationRunId],
      foreignColumns: [declarationRuns.id],
    }).onDelete('cascade'),

    finalCodeFk: foreignKey({
      name: 'declaration_run_items_final_code_fk',
      columns: [t.finalCode],
      foreignColumns: [hsCodes.code],
    }).onDelete('restrict'),

    setRowUniq: unique('declaration_run_items_set_row_uniq').on(t.declarationRunId, t.rowIndex),

    /**
     * Composite (declaration_run_id, row_index) index. Covers
     * WHERE declaration_run_id = $1 lookups via leftmost-prefix AND
     * satisfies ORDER BY row_index without an in-memory sort.
     */
    setRowIdx: index('declaration_run_items_set_row_idx').on(t.declarationRunId, t.rowIndex),
  }),
);

export type BatchItemRow = typeof declarationRunItems.$inferSelect;
export type NewDeclarationRunItemRow = typeof declarationRunItems.$inferInsert;
