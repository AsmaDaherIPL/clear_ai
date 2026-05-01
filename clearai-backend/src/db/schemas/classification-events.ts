/** classification_events — append-only log of every endpoint call (ADR-0001). */
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  jsonb,
  index,
  doublePrecision,
  boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const classificationEvents = pgTable(
  'classification_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    endpoint: varchar('endpoint', { length: 32 }).notNull(), // 'describe' | 'expand' | 'boost'
    request: jsonb('request').notNull(),
    languageDetected: varchar('language_detected', { length: 8 }), // 'en' | 'ar' | 'mixed' | 'unk'

    decisionStatus: varchar('decision_status', { length: 24 }).notNull(),
    decisionReason: varchar('decision_reason', { length: 32 }).notNull(),
    confidenceBand: varchar('confidence_band', { length: 8 }), // 'high' | 'medium' | 'low' | null

    chosenCode: varchar('chosen_code', { length: 12 }),
    alternatives: jsonb('alternatives'),

    topRetrievalScore: doublePrecision('top_retrieval_score'),
    top2Gap: doublePrecision('top2_gap'),
    candidateCount: integer('candidate_count'),
    branchSize: integer('branch_size'),

    llmUsed: boolean('llm_used').notNull().default(false),
    llmStatus: varchar('llm_status', { length: 24 }), // 'ok' | 'error' | 'timeout' | null
    guardTripped: boolean('guard_tripped').notNull().default(false),

    modelCalls: jsonb('model_calls'),
    embedderVersion: varchar('embedder_version', { length: 64 }),
    llmModel: varchar('llm_model', { length: 64 }),
    totalLatencyMs: integer('total_latency_ms'),
    error: text('error'),
    /** Picker's plain-English reason for the chosen code. Null when no picker ran. */
    rationale: text('rationale'),
  },
  (t) => ({
    createdAtIdx: index('events_created_at_idx').on(t.createdAt),
    endpointIdx: index('events_endpoint_idx').on(t.endpoint),
    statusIdx: index('events_status_idx').on(t.decisionStatus),
  })
);

export type ClassificationEventRow = typeof classificationEvents.$inferSelect;
export type NewClassificationEventRow = typeof classificationEvents.$inferInsert;
