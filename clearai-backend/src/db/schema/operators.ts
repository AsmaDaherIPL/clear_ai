/**
 * tenants — registry of carriers/brokers using ClearAI.
 *
 * Source of truth for operator identity. ZATCA tunables (HV threshold, bundle
 * size) live in setup_meta — they're spec-wide, not per-operator — see
 * migration 0046.
 *
 * Related tables:
 *   • operator_field_mappings  — per-operator column mapping rules (FK to slug)
 *   • operator_constants       — per-operator envelope-shaping values
 *   • operator_lookups         — per-operator value translations
 *   • declaration_runs       — every set is owned by one operator slug
 *   • operator_code_overrides  — pre-dates this registry; not FK'd yet (see 0038 header)
 *
 * PK is uuid (rule 1: every entity table gets a uuid PK). The natural key is
 * `slug`, which is UNIQUE and is what every other operator-scoped table FK's to.
 */
import { pgTable, uuid, varchar, text, boolean, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const operators = pgTable(
  'operators',
  {
    /** Synthetic uuid PK. App writes use newId() (UUIDv7); DB default is the safety net. */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Lowercase ASCII slug; FK target for every other operator-scoped table. */
    slug: varchar('slug', { length: 32 }).notNull(),

    /** Human-readable display name for admin UIs / audit logs. */
    displayName: text('display_name').notNull(),

    /** Defaults to false so a fresh operator row can't accept traffic without explicit activation. */
    active: boolean('active').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Auto-bumped by tenants_touch_updated_at_trg (see 0038). */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUniq: unique('operators_slug_uniq').on(t.slug),
  }),
);

export type OperatorRow = typeof operators.$inferSelect;
export type NewOperatorRow = typeof operators.$inferInsert;
