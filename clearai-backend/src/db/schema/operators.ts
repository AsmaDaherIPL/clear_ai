/**
 * operators — registry of carriers/brokers using ClearAI.
 *
 * Source of truth for operator identity. ZATCA tunables (HV threshold, bundle
 * size) live in setup_meta — they're spec-wide, not per-operator — see
 * migration 0046.
 *
 * Related tables (all FK on operators.id):
 *   • operator_field_mappings  — per-operator column mapping rules
 *   • operator_constants       — per-operator envelope-shaping values
 *   • operator_lookups         — per-operator value translations
 *   • operator_code_overrides  — per-operator HS-code overrides
 *   • declaration_runs         — every run is owned by one operator
 *
 * PK is uuid (rule 1: every entity table gets a uuid PK). `slug` is a UNIQUE
 * human-readable label kept on the operators table only — it is NOT a foreign-
 * key target. Children reference operators.id (added in migration 0050).
 */
import { pgTable, uuid, varchar, text, boolean, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const operators = pgTable(
  'operators',
  {
    /** Synthetic uuid PK. App writes use newId() (UUIDv7); DB default is the safety net. */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Lowercase ASCII slug; UNIQUE human label. Not a FK target — children FK on id. */
    slug: varchar('slug', { length: 32 }).notNull(),

    /** Human-readable display name for admin UIs / audit logs. */
    displayName: text('display_name').notNull(),

    /** Defaults to false so a fresh operator row can't accept traffic without explicit activation. */
    active: boolean('active').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Auto-bumped by operators_touch_updated_at_trg (renamed from tenants_*). */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUniq: unique('operators_slug_uniq').on(t.slug),
  }),
);

export type OperatorRow = typeof operators.$inferSelect;
export type NewOperatorRow = typeof operators.$inferInsert;
