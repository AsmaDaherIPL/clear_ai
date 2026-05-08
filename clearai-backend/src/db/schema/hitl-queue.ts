/**
 * hitl_queue — pending human-in-the-loop reviews.
 *
 * One row per item that the pipeline escalated. The orchestrator returns
 * its HITL intent on PipelineResult, then the dispatch route writes the
 * classification_events row first and the hitl_queue row second so the FK
 * is always satisfied.
 *
 * v0 access policy (enforced at the app layer): rows are filtered by
 * operator_slug. Any logged-in user with access to operator X sees X's
 * pending items. No assignment / claim semantics yet.
 */
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

    classificationEventId: uuid('classification_event_id')
      .notNull()
      .references(() => classificationEvents.id, { onDelete: 'cascade' }),

    itemId: uuid('item_id').notNull(),
    operatorSlug: varchar('operator_slug', { length: 64 }).notNull(),

    /** 'verdict_escalate' (Stage 2) | 'sanity_flag' (Stage 3 FLAG). */
    reason: varchar('reason', { length: 32 }).notNull(),

    /** 'pending' | 'in_review' | 'resolved' | 'dismissed'. */
    status: varchar('status', { length: 16 }).notNull().default('pending'),

    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    /** 'approve' | 'override' | 'reject' — populated when reviewer acts. */
    reviewerDecision: varchar('reviewer_decision', { length: 16 }),
    reviewerCode: varchar('reviewer_code', { length: 12 }),
    reviewerNotes: text('reviewer_notes'),

    /** Forensic snapshot: cleaned_description, verdict_output, sanity_result, full trace. */
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
