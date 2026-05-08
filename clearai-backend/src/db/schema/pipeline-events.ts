/**
 * pipeline_events — append-only audit log for /pipeline/dispatch and the
 * per-item batch path. Replaces the legacy classification_events +
 * classification_feedback tables (dropped in 0059).
 *
 * Design intent: minimal columns for the dimensions you filter and
 * aggregate on regularly; full DispatchV1Trace stays in `trace` jsonb.
 * Anything else needed for an ad-hoc query lives inside the trace.
 */
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { operators } from './operators.js';

export const pipelineEvents = pgTable(
  'pipeline_events',
  {
    id: uuid('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    operatorId: uuid('operator_id').references(() => operators.id, { onDelete: 'set null' }),
    operatorSlug: varchar('operator_slug', { length: 64 }).notNull(),

    /** Final dispatch outcome — 'succeeded' | 'failed' | 'rejected' | 'flagged'. */
    status: varchar('status', { length: 16 }).notNull(),
    finalCode: varchar('final_code', { length: 12 }),
    /**
     * Sanity LLM's outcome — 'PASS' | 'FLAG' | 'BLOCK' | null. Null when
     * sanity was skipped (escalated reconciliation) or feature-disabled.
     * BLOCK is reserved for upstream pre-classification rejections that
     * the orchestrator emits before the sanity LLM runs.
     */
    sanityVerdict: varchar('sanity_verdict', { length: 8 }),

    descriptionClassifierChosenCode: varchar('description_classifier_chosen_code', { length: 12 }),
    descriptionClassifierConfidence: doublePrecision('description_classifier_confidence'),

    codeResolverResolvedCode: varchar('code_resolver_resolved_code', { length: 12 }),
    /**
     * How the code_resolver arrived at its result. One of:
     *   'deterministic_passthrough'    — active 12-digit, no swap
     *   'deterministic_swap'           — deleted, single replacement
     *   'llm_pick_among_replacements'  — deleted, N replacements, LLM picked
     *   'llm_pick_under_prefix'        — 6/8/10-digit prefix expanded
     *   'tenant_override'              — terminal override hit (until the
     *                                    override-then-codebook redesign lands)
     *   'null_resolution'              — nothing usable
     */
    codeResolverPath: varchar('code_resolver_path', { length: 40 }),
    tenantOverrideApplied: boolean('tenant_override_applied').notNull().default(false),

    totalLatencyMs: integer('total_latency_ms').notNull(),
    /** PII-redacted dispatch request body. */
    request: jsonb('request').notNull(),
    /** Full DispatchV1Trace. */
    trace: jsonb('trace').notNull(),
  },
  (t) => ({
    createdAtIdx: index('pipeline_events_created_at_idx').on(sql`${t.createdAt} DESC`),
    operatorIdx: index('pipeline_events_operator_idx').on(t.operatorId, sql`${t.createdAt} DESC`),
    statusIdx: index('pipeline_events_status_idx').on(t.status),
    resolverPathIdx: index('pipeline_events_resolver_path_idx').on(t.codeResolverPath),
  }),
);

export type PipelineEventRow = typeof pipelineEvents.$inferSelect;
export type NewPipelineEventRow = typeof pipelineEvents.$inferInsert;
