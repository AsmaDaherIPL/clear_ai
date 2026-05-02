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

    /**
     * Phase 2.4 PII-redacted shadow copy of `request`. Read-safe for every
     * role; the unredacted `request` column is admin-only via column GRANT.
     * Added to the live DB in 0019_role_separation.sql; only added to the
     * Drizzle schema in 0035 (it was missing for several migrations and
     * didn't cause runtime issues because the application uses raw SQL,
     * not Drizzle's query builder, for log-event INSERTs).
     */
    requestRedacted: jsonb('request_redacted'),

    // ──── Observability columns (0035) ─────────────────────────────────
    // All NULLable. Existing rows can't be backfilled — the signals
    // weren't captured at insert time. Frontend / trace queries should
    // treat NULL as "wasn't recorded for this event".

    /**
     * Chapter-hint output stored verbatim as jsonb (LLM output shape):
     *   { likely_chapters: [...], confidence: 0..1, rationale: "..." }
     * Used by the trace page to show why retrieval was prefix-filtered
     * (or why the hint was ignored — confidence < 0.80 threshold).
     */
    chapterHint: jsonb('chapter_hint'),

    /**
     * Cleanup module's nounGrounded flag (true iff a real customs noun
     * was recovered). Lets the trace page distinguish "shorthand routed
     * to Researcher" (false) from "happy product retrieval" (true)
     * without parsing the request jsonb.
     */
    cleanupNounGrounded: boolean('cleanup_noun_grounded'),

    /**
     * Stage-1 vector recall pool size before BM25/trigram rerank.
     * Useful for diagnosing "no candidates returned" vs "no candidates
     * survived the chapter-hint prefix filter" failures.
     */
    retrievalStage1Count: integer('retrieval_stage1_count'),
  },
  (t) => ({
    createdAtIdx: index('events_created_at_idx').on(t.createdAt),
    endpointIdx: index('events_endpoint_idx').on(t.endpoint),
    statusIdx: index('events_status_idx').on(t.decisionStatus),
  })
);

export type ClassificationEventRow = typeof classificationEvents.$inferSelect;
export type NewClassificationEventRow = typeof classificationEvents.$inferInsert;
