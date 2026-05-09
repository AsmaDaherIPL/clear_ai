import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { classificationEvents } from './classification-events.js';

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
  }),
);

export type HitlQueueRow = typeof hitlQueue.$inferSelect;
export type NewHitlQueueRow = typeof hitlQueue.$inferInsert;
