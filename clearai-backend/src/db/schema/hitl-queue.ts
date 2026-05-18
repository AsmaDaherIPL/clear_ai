import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { classificationEvents } from './classification-events.js';
import { batches } from './batches.js';

export const hitlQueue = pgTable(
  'hitl_queue',
  {
    id: uuid('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull(),

    // Cascade delete: dropping a classification_events row removes its
    // associated review work — there's no review to do for a code that
    // was never recorded.
    classificationEventId: uuid('classification_event_id')
      .notNull()
      .references(() => classificationEvents.id, { onDelete: 'cascade' }),

    /**
     * Parent batch id. NULLABLE: single-shot dispatches
     * (POST /classifications/dispatch) produce HITL rows without a parent
     * batch. FK to batches(id) ON DELETE CASCADE so deleting a
     * batch cleans up its review rows. NULL for single-shot reviews.
     * Added in migration 0075; FK target renamed in migration 0084.
     */
    batchId: uuid('batch_id'),

    /**
     * Canonical item UUID. For batch rows this matches a
     * batch_items.id. For single-shot rows, it's just the
     * classification_events.id (= response.item_id) and has no row in
     * batch_items. NO FK constraint — see migration 0075 comment for why.
     */
    itemId: uuid('item_id').notNull(),
    operatorSlug: varchar('operator_slug', { length: 64 }).notNull(),

    reason: varchar('reason', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),

    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    reviewerDecision: varchar('reviewer_decision', { length: 16 }),
    reviewerCode: varchar('reviewer_code', { length: 12 }),
    reviewerNotes: text('reviewer_notes'),

    payload: jsonb('payload').notNull(),
  },
  (t) => ({
    statusIdx: index('hitl_queue_status_idx').on(t.status, t.createdAt),
    operatorIdx: index('hitl_queue_operator_idx').on(t.operatorSlug, t.status),
    eventIdx: index('hitl_queue_event_idx').on(t.classificationEventId),
    batchIdx: index('hitl_queue_batch_idx').on(t.batchId, t.status),
    batchFk: foreignKey({
      name: 'hitl_queue_batch_id_fkey',
      columns: [t.batchId],
      foreignColumns: [batches.id],
    }).onDelete('cascade'),
    // No FK on item_id — single-shot dispatches have an item_id that
    // only exists in classification_events, not in batch_items.
  }),
);

export type HitlQueueRow = typeof hitlQueue.$inferSelect;
export type NewHitlQueueRow = typeof hitlQueue.$inferInsert;
