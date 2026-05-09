/**
 * Append-only audit log. Top-level columns are the dimensions filtered
 * and aggregated on regularly; everything else lives in `trace` jsonb.
 */
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
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

    status: varchar('status', { length: 16 }).notNull(),
    finalCode: varchar('final_code', { length: 12 }),
    // Null when sanity was skipped upstream (e.g. escalated reconciliation
    // never reached the sanity stage). BLOCK is emitted by the orchestrator
    // for pre-classification rejections; the LLM itself only returns PASS/FLAG.
    sanityVerdict: varchar('sanity_verdict', { length: 8 }),

    descriptionClassifierTopFitCode: varchar('description_classifier_top_fit_code', { length: 12 }),

    codeResolverResolvedCode: varchar('code_resolver_resolved_code', { length: 12 }),
    codeResolverPath: varchar('code_resolver_path', { length: 40 }),
    tenantOverrideApplied: boolean('tenant_override_applied').notNull().default(false),

    totalLatencyMs: integer('total_latency_ms').notNull(),
    request: jsonb('request').notNull(),
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
