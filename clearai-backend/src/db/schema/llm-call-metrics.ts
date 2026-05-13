/**
 * llm_call_metrics — per-call observability row for the Foundry LLM
 * transport. Written fire-and-forget from finalize() in
 * inference/llm/client.ts (one row per `callLlm` invocation, including
 * each retry inside `callLlmWithRetry`).
 *
 * Powers GET /admin/llm-call-metrics — operators answer "what's the picker
 * transient rate over the last hour?" without parsing individual trace
 * blobs.
 *
 * See migration 0078_llm_call_metrics.sql for the CHECK constraint on
 * `outcomeClass` and the (ts DESC) / (stage, ts DESC) indexes.
 */
import { pgTable, uuid, varchar, smallint, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Mirror of llm_call_metrics_outcome_class_chk and breaker.ts:LlmFailureClass. */
export type LlmOutcomeClass = 'ok' | 'auth_class' | 'transient' | 'other';

export const llmCallMetrics = pgTable(
  'llm_call_metrics',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    /** LlmStage label from inference/llm/policy.ts. Free-form here so a new stage doesn't need a migration. */
    stage: varchar('stage', { length: 64 }).notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    /** 1-based attempt index inside callLlmWithRetry's loop. */
    attempt: smallint('attempt').notNull(),
    outcomeClass: varchar('outcome_class', { length: 32 }).notNull().$type<LlmOutcomeClass>(),
    latencyMs: integer('latency_ms').notNull(),
    /** Parsed from "HTTP NNN: ..." when present; NULL on timeouts / network errors / success. */
    httpStatus: smallint('http_status'),
    /** Transport LlmStatus on non-ok results ('error' | 'timeout'); NULL on success. */
    errorClass: varchar('error_class', { length: 32 }),
  },
  (t) => ({
    tsIdx: index('llm_call_metrics_ts_idx').on(t.ts.desc()),
    stageTsIdx: index('llm_call_metrics_stage_ts_idx').on(t.stage, t.ts.desc()),
  }),
);

export type LlmCallMetricRow = typeof llmCallMetrics.$inferSelect;
export type NewLlmCallMetricRow = typeof llmCallMetrics.$inferInsert;
