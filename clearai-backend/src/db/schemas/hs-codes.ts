/**
 * `hs_codes` — the ZATCA tariff catalogue.
 *
 * Source of truth: `Zatca Tariff codes.xlsx`. We store **only HS12 leaf rows**
 * (the 33 HS4 headings are dropped at ingest — see ADR-0008). Hierarchy levels
 * (`chapter`/`heading`/`hs6`/`hs8`/`hs10`/`parent10`) are derived from the
 * 12-digit prefix at ingest (ADR-0005).
 *
 * Hard invariants (declared as DB CHECK constraints in 0002_hardening.sql,
 * not just here):
 *   - `code ~ '^\d{12}$'`
 *   - `raw_length = 12` and `is_leaf = true`
 *   - prefix columns are exact substrings of `code`
 *   - `parent10 = substring(code, 1, 10)`
 */
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  index,
  boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vector, tsvector } from '../types.js';

export const hsCodes = pgTable(
  'hs_codes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: varchar('code', { length: 12 }).notNull().unique(),

    // derived hierarchy prefixes (ADR-0005)
    chapter: varchar('chapter', { length: 2 }).notNull(),
    heading: varchar('heading', { length: 4 }).notNull(),
    hs6: varchar('hs6', { length: 6 }).notNull(),
    hs8: varchar('hs8', { length: 8 }).notNull(),
    hs10: varchar('hs10', { length: 10 }).notNull(),
    parent10: varchar('parent10', { length: 10 }).notNull(),

    descriptionEn: text('description_en'),
    descriptionAr: text('description_ar'),
    dutyEn: text('duty_en'),
    dutyAr: text('duty_ar'),
    procedures: text('procedures'),

    // ts vectors built from descriptions; populated via SQL trigger after insert
    tsvEn: tsvector('tsv_en'),
    tsvAr: tsvector('tsv_ar'),

    // 384-dim e5 embedding over EN+AR concatenated description
    embedding: vector('embedding', { dim: 384 }),

    isLeaf: boolean('is_leaf').notNull().default(true), // always true post-ADR-0008
    rawLength: integer('raw_length').notNull(), // always 12 post-ADR-0008

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    chapterIdx: index('hs_codes_chapter_idx').on(t.chapter),
    headingIdx: index('hs_codes_heading_idx').on(t.heading),
    hs6Idx: index('hs_codes_hs6_idx').on(t.hs6),
    hs8Idx: index('hs_codes_hs8_idx').on(t.hs8),
    hs10Idx: index('hs_codes_hs10_idx').on(t.hs10),
    parent10Idx: index('hs_codes_parent10_idx').on(t.parent10),
    leafIdx: index('hs_codes_leaf_idx').on(t.isLeaf),
    // BM25/tsvector + HNSW + trgm indexes are added via raw SQL in 0001_indexes_triggers.sql
  })
);

export type HsCodeRow = typeof hsCodes.$inferSelect;
export type NewHsCodeRow = typeof hsCodes.$inferInsert;
