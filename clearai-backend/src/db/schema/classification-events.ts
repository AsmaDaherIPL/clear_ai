/**
 * classification_events — append-only audit log for /pipeline/dispatch.
 *
 * Renamed from the original classification_events (legacy describe/expand
 * shape, dropped in 0059) and from the interim pipeline_events name (0059)
 * back to classification_events in 0060 to match team vocabulary.
 *
 * Design intent: minimal columns for the dimensions you filter and
 * aggregate on regularly; full DispatchV1Trace stays in `trace` jsonb.
 * Anything else needed for ad-hoc queries lives inside the trace.
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

export const classificationEvents = pgTable(
  'classification_events',
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
    createdAtIdx: index('classification_events_created_at_idx').on(sql`${t.createdAt} DESC`),
    operatorIdx: index('classification_events_operator_idx').on(t.operatorId, sql`${t.createdAt} DESC`),
    statusIdx: index('classification_events_status_idx').on(t.status),
    resolverPathIdx: index('classification_events_resolver_path_idx').on(t.codeResolverPath),
  }),
);

export type ClassificationEventRow = typeof classificationEvents.$inferSelect;
export type NewClassificationEventRow = typeof classificationEvents.$inferInsert;
