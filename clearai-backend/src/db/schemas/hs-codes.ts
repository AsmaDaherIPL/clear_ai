/** hs_codes — ZATCA tariff catalogue (HS12 leaves only, ADR-0008). */
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  date,
  index,
  boolean,
  json,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vector, tsvector } from '../types.js';

export const hsCodes = pgTable(
  'hs_codes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: varchar('code', { length: 12 }).notNull().unique(),

    // Derived hierarchy prefixes (ADR-0005).
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

    // tsvectors populated by SQL trigger after insert.
    tsvEn: tsvector('tsv_en'),
    tsvAr: tsvector('tsv_ar'),

    // 384-dim e5 embedding over EN+AR concatenated description.
    embedding: vector('embedding', { dim: 384 }),

    isLeaf: boolean('is_leaf').notNull().default(true),
    rawLength: integer('raw_length').notNull(),

    // SABER deletion tracking (ADR: added via 0021_hs_codes_deletion.sql).
    // Deleted codes are excluded from retrieval, branch enumeration, and
    // broker-mapping target lookups via AND NOT is_deleted predicates.
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
    hs8Idx: index('hs_codes_hs8_idx').on(t.hs8),
    hs10Idx: index('hs_codes_hs10_idx').on(t.hs10),
    parent10Idx: index('hs_codes_parent10_idx').on(t.parent10),
    leafIdx: index('hs_codes_leaf_idx').on(t.isLeaf),
    // BM25 / HNSW / trgm indexes added via raw SQL in 0001_indexes_triggers.sql.
  })
);

export type HsCodeRow = typeof hsCodes.$inferSelect;
export type NewHsCodeRow = typeof hsCodes.$inferInsert;
