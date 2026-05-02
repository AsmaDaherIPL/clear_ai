/**
 * hs_codes — verbatim ZATCA tariff catalogue (HS12 leaves only, ADR-0008).
 *
 * Post-ADR-0025 (split-catalog refactor):
 *   • This table holds raw ZATCA strings only — verbatim source of truth.
 *   • Derived display data lives in hs_code_display (label_en/ar, path_en/ar,
 *     path_codes, depth, is_generic_label, is_declarable).
 *   • Search index lives in hs_code_search (embedding, tsv_*, tsv_input_*).
 *   • SABER deletion tracking stays here (is_deleted, deletion_effective_date,
 *     replacement_codes); a trigger mirrors is_deleted to hs_code_search.
 */
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  index,
  boolean,
  json,
  numeric,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const hsCodes = pgTable(
  'hs_codes',
  {
    // PK policy: ids supplied by application code via src/util/uuid.ts
    // (UUIDv7 — time-ordered, btree-friendly). The DB default is kept
    // as a safety net for any path that doesn't yet supply id; it
    // produces UUIDv4 which is still a valid UUID, just slightly less
    // index-friendly. PG 18+ may swap this for native uuidv7().
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: varchar('code', { length: 12 }).notNull().unique(),

    // Derived hierarchy prefixes (ADR-0005). Kept: chapter / heading / hs6
    // — these are used as indexable JOIN/filter targets across the codebase.
    // Dropped (0030): hs8, hs10, parent10 — were dead duplications of
    // substring(code, 1, 8/10), now derived in TS by loadKnownPrefixes()
    // from `code` at startup.
    chapter: varchar('chapter', { length: 2 }).notNull(),
    heading: varchar('heading', { length: 4 }).notNull(),
    hs6: varchar('hs6', { length: 6 }).notNull(),

    descriptionEn: text('description_en'),
    descriptionAr: text('description_ar'),

    // Duty (post-0031): parsed at ingest into rate + status enum.
    // duty_rate_pct is non-null IFF duty_status='rate'; the CHECK
    // constraint hs_codes_duty_consistency_chk enforces this.
    dutyRatePct: numeric('duty_rate_pct', { precision: 5, scale: 2 }),
    dutyStatus: text('duty_status'),  // 'rate' | 'exempted' | 'prohibited_import' | 'prohibited_export' | 'prohibited_both'

    // Required-procedures codes (post-0031): Postgres text[] of 1–4 char
    // procedure-code identifiers, e.g. {'61','98'}. Looked up against
    // procedure_codes for human-readable Arabic descriptions at request time.
    procedures: text('procedures').array(),

    // SABER deletion tracking (ADR-0021). Trigger
    // hs_codes_propagate_deletion_trigger (added in 0028) mirrors
    // is_deleted into hs_code_search.is_deleted automatically.
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletionEffectiveDate: date('deletion_effective_date'),
    /** JSON array of 12-digit replacement codes, e.g. ["550111000001","550111009999"]. */
    replacementCodes: json('replacement_codes').$type<string[]>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    chapterIdx: index('hs_codes_chapter_idx').on(t.chapter),
    headingIdx: index('hs_codes_heading_idx').on(t.heading),
    hs6Idx: index('hs_codes_hs6_idx').on(t.hs6),
  }),
);

export type HsCodeRow = typeof hsCodes.$inferSelect;
export type NewHsCodeRow = typeof hsCodes.$inferInsert;
