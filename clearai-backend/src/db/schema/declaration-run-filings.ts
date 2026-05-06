/**
 * declarations — one row per rendered ZATCA Declaration bundle.
 *
 * Inserted by Phase 2 (modules/declaration-runs/filings/). HV bundles
 * hold exactly one item; LV bundles up to tenants.bundle_size.
 *
 * `bayan_no` is populated post-submission (out-of-band today; future API
 * integration in v1).
 *
 * Related tables:
 *   • declaration_runs — FK target (declaration_run_id -> declaration_runs.id) ON DELETE CASCADE
 */
import { pgTable, uuid, integer, text, timestamp, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { declarationRuns } from './declaration-runs.js';

export type BundleStrategy = 'HV_STANDALONE' | 'LV_BUNDLED';

export const declarationRunFilings = pgTable(
  'declaration_run_filings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Parent declaration_run. FK -> declaration_runs(id) ON DELETE CASCADE. */
    declarationRunId: uuid('declaration_run_id').notNull(),
    /** 0-based ordinal within the set's render order. */
    bundleIndex: integer('bundle_index').notNull(),
    /** CHECK-locked closed enum; mirror in batch-declaration.types.ts. */
    bundleStrategy: text('bundle_strategy').notNull().$type<BundleStrategy>(),
    /** HV_STANDALONE = 1; LV_BUNDLED in [1, operator.bundle_size]. */
    itemCount: integer('item_count').notNull(),
    /** Blob key (under BATCH_BLOB_CONTAINER). */
    blobKey: text('blob_key').notNull(),
    /** Carrier's submission receipt id. Nullable until submitted. */
    bayanNo: text('bayan_no'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    setFk: foreignKey({
      name: 'declarations_set_fk',
      columns: [t.declarationRunId],
      foreignColumns: [declarationRuns.id],
    }).onDelete('cascade'),

    setBundleUniq: unique('declarations_set_bundle_uniq').on(t.declarationRunId, t.bundleIndex),

    setIdx: index('declarations_set_idx').on(t.declarationRunId),
  }),
);

export type DeclarationRow = typeof declarationRunFilings.$inferSelect;
export type NewDeclarationRow = typeof declarationRunFilings.$inferInsert;
