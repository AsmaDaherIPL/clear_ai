/**
 * hs_code_search — search index for hybrid retrieval. See 0028_hs_code_search.sql
 * + ADR-0025 for rationale.
 *
 * Asymmetric per-arm input:
 *   • Vector arm   → embedding (computed from `embedding_input`, one passage)
 *   • BM25 arm     → tsv_en / tsv_ar (trigger-built from tsv_input_*)
 *   • Trigram arm  → tsv_input_en / tsv_input_ar (deduplicated token bag)
 *
 * is_deleted is a denormalised mirror of hs_codes.is_deleted maintained
 * by an AFTER-INSERT/UPDATE trigger on hs_codes — application code does
 * not write this column directly.
 */
import {
  pgTable,
  char,
  text,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { vector, tsvector } from '../types.js';
import { hsCodes } from './hs-codes.js';

export const hsCodeSearch = pgTable(
  'hs_code_search',
  {
    code: char('code', { length: 12 })
      .primaryKey()
      .references(() => hsCodes.code, { onDelete: 'cascade' }),

    /** Exact bytes fed to embedder. Single coherent passage, bilingual. */
    embeddingInput: text('embedding_input').notNull(),

    /** Deduplicated token bag for BM25/trigram (English). */
    tsvInputEn: text('tsv_input_en').notNull(),
    tsvInputAr: text('tsv_input_ar'),

    /** 384-dim e5-small vector. */
    embedding: vector('embedding', { dim: 384 }),
    embeddingModel: text('embedding_model').notNull(),

    /** Maintained by trigger from tsv_input_*. */
    tsvEn: tsvector('tsv_en'),
    tsvAr: tsvector('tsv_ar'),

    /** Denormalised mirror of hs_codes.is_deleted (trigger-maintained). */
    isDeleted: boolean('is_deleted').notNull().default(false),

    /** Ingest pipeline version (git SHA / semver). */
    buildVersion: text('build_version').notNull(),

    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index('hs_code_search_active_idx').on(t.code),
    // HNSW + GIN indexes are declared in raw SQL (Drizzle doesn't have
    // first-class index types for those yet); they live in the migration.
  }),
);

export type HsCodeSearchRow = typeof hsCodeSearch.$inferSelect;
export type NewHsCodeSearchRow = typeof hsCodeSearch.$inferInsert;
