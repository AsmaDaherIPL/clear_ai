/**
 * tenants — registry of carriers/brokers using ClearAI.
 *
 * Source of truth for tenant slugs and per-tenant tunables (bundle_size,
 * hv_threshold_sar) that drive ZATCA Declaration HV/LV partitioning.
 *
 * Related tables:
 *   • tenant_field_mappings — per-tenant column mapping rules (FK to slug)
 *   • tenant_constants      — per-tenant fixed values for the ZATCA envelope
 *   • tenant_lookups        — per-tenant value translations (city, currency, ...)
 *   • batches               — every batch is owned by one tenant slug
 *   • tenant_code_overrides — pre-dates this registry; not FK'd yet (see 0038 header)
 *
 * PK is uuid (rule 1: every entity table gets a uuid PK). The natural key is
 * `slug`, which is UNIQUE and is what every other tenant-scoped table FK's to.
 */
import { pgTable, uuid, varchar, text, integer, numeric, boolean, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenants = pgTable(
  'tenants',
  {
    /** Synthetic uuid PK. App writes use newId() (UUIDv7); DB default is the safety net. */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Lowercase ASCII slug; FK target for every other tenant-scoped table. */
    slug: varchar('slug', { length: 32 }).notNull(),

    /** Human-readable display name for admin UIs / audit logs. */
    displayName: text('display_name').notNull(),

    /** ZATCA Declaration LV chunk size. Bounded 1..999 by tenants_bundle_size_range_chk. */
    bundleSize: integer('bundle_size').notNull().default(99),

    /**
     * HV partition threshold in SAR. Items with value_amount >= this go to
     * standalone declarations; below get bundled into chunks of bundle_size.
     */
    hvThresholdSar: numeric('hv_threshold_sar', { precision: 12, scale: 2 }).notNull().default('1000.00'),

    /** Defaults to false so a fresh tenant row can't accept traffic without explicit activation. */
    active: boolean('active').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Auto-bumped by tenants_touch_updated_at_trg (see 0038). */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUniq: unique('tenants_slug_uniq').on(t.slug),
  }),
);

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;
