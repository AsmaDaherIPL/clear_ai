/**
 * operators — identity-only registry of carriers/brokers.
 *
 * Render defaults (ZATCA submitter, envelope constants, consignee
 * address) live on operator_declaration_config (1:1).
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

    // ── Tabadul identity (renderer reads these directly) ──

    /** Tabadul login userid (`<decsub:userid>`). */
    tabadulUserid: varchar('tabadul_userid', { length: 64 }),

    /** Tabadul account id (`<decsub:acctId>`). */
    tabadulAcctId: varchar('tabadul_acct_id', { length: 64 }),

    /** Broker license type (`<deccm:brokerLicenseType>`). */
    brokerLicenseType: varchar('broker_license_type', { length: 8 }),

    /** Broker license number (`<deccm:brokerLicenseNo>`). */
    brokerLicenseNo: varchar('broker_license_no', { length: 32 }),

    /** Broker representative number (`<deccm:brokerRepresentativeNo>`). */
    brokerRepresentativeNo: varchar('broker_representative_no', { length: 32 }),

    /** Fallback `<deccm:sourceCompanyName>` when the per-row client_source_company lookup misses. */
    defaultSourceCompanyName: text('default_source_company_name'),

    /** Fallback `<decsub:sourceCompanyNo>` for the same case. */
    defaultSourceCompanyNo: varchar('default_source_company_no', { length: 32 }),

    // ZATCA submitter, envelope constants, and consignee-address
    // defaults moved to operator_declaration_config in 0063. This row
    // holds identity-toward-Tabadul/SABER only.

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Auto-bumped by operators_touch_updated_at_trg. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUniq: unique('operators_slug_uniq').on(t.slug),
  }),
);

export type OperatorRow = typeof operators.$inferSelect;
export type NewOperatorRow = typeof operators.$inferInsert;
