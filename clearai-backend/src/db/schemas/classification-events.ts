/**
 * `classification_events` — append-only log of every endpoint call's
 * status-driven decision (ADR-0001).
 *
 * Closed-enum columns (`endpoint`, `decision_status`, `decision_reason`,
 * `confidence_band`, `llm_status`, `language_detected`) are constrained by
 * CHECK constraints in 0002_hardening.sql so a typo in TypeScript can't
 * silently land an invalid value. The TS types in `classification/types.ts` are
 * the single source of truth; the SQL CHECKs mirror them.
 */
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
    // Picker's plain-English explanation of *why* this code was chosen.
    // Persisted so GET /trace/:eventId can render it after the original
    // response is gone. Null for paths that don't produce one (degraded,
    // best-effort fallback, gate-failed-no-llm).
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
