/**
 * operators — registry of carriers/brokers using ClearAI.
 *
 * Source of truth for operator identity. ZATCA tunables (HV threshold, bundle
 * size) live in setup_meta — they're spec-wide, not per-operator. ZATCA-spec
 * envelope defaults live in zatca_declaration_defaults — also spec-wide.
 *
 * Operator-identity values that used to live as key-value rows in
 * operator_constants are now first-class columns here (migration 0054):
 *   tabadul_userid, tabadul_acct_id, broker_license_type, broker_license_no,
 *   broker_representative_no, default_source_company_name, default_source_company_no
 *
 * Related tables (all FK on operators.id):
 *   • operator_field_mappings  — per-operator column mapping rules
 *   • operator_constants       — per-operator placeholders (TODO: drop once empty)
 *   • operator_lookups         — per-operator value translations
 *   • operator_code_overrides  — per-operator HS-code overrides
 *   • declaration_runs         — every run is owned by one operator
 *
 * PK is uuid; `slug` is a UNIQUE human-readable label kept on the operators
 * table only — it is NOT a foreign-key target (children FK on id).
 */
import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Shape of operators.default_consignee_address jsonb. Used by the renderer
 * as the operator-level fallback when a row's canonical.consigneeAddress
 * is null or missing fields.
 *
 * All fields are individually optional (the per-row override might fill
 * one of them while leaving others to fall back to the operator default).
 */
export interface OperatorDefaultConsigneeAddress {
  cityCode?: string;
  zipCode?: string;
  poBox?: string;
  /** Free-text Arabic street address. */
  streetAr?: string;
}

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

    // ── ZATCA submitter identity (was env vars; moved here in 0062) ──

    /** ZATCA-assigned carrier id. Filled by an admin from Naqel's ZATCA registration. */
    zatcaSubmitterCarrierId: varchar('zatca_submitter_carrier_id', { length: 32 }),

    /** Submitter name in the declaration envelope. Falls back to display_name when null. */
    zatcaSubmitterName: text('zatca_submitter_name'),

    /** XML namespace ZATCA assigns. Almost always 'http://www.saudiedi.com/schema/decsub'; column lets it be overridden per operator. */
    zatcaDeclarationNamespace: text('zatca_declaration_namespace'),

    /**
     * Operator-level consignee-address default. The 4 fields (cityCode,
     * zipCode, poBox, streetAr) feed the `<decsub:expressMailInfomation>`
     * block. Used as the fallback when a row's canonical.consigneeAddress
     * is null or missing a specific field. NULL when the operator hasn't
     * configured any defaults — in that case the renderer requires every
     * field to come from the canonical row.
     */
    defaultConsigneeAddress: jsonb('default_consignee_address').$type<OperatorDefaultConsigneeAddress>(),

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
