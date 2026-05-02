/**
 * hs_code_search — search index for hybrid retrieval. See 0028_hs_code_search.sql
 * + ADR-0025 for rationale.
 *
 * Asymmetric per-arm input:
 *   • Vector arm   → embedding (computed from `embedding_input`, one passage)
 *   • BM25 arm     → tsv_en / tsv_ar (trigger-built from tsv_input_*)
 *   • Trigram arm  → tsv_input_en / tsv_input_ar (deduplicated token bag)
 *
 * Deletion filtering: retrieval JOINs hs_codes and reads h.is_deleted
 * directly (single source of truth). The denormalised is_deleted column
 * + sync trigger that lived here in commits #4–5 was removed in 0030 —
 * the JOIN cost is microseconds at our scale and eliminates a sync
 * hazard.
 */
import {
  pgTable,
  char,
  text,
  timestamp,
  uuid,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { vector, tsvector } from '../types.js';
import { hsCodes } from './hs-codes.js';

export const hsCodeSearch = pgTable(
  'hs_code_search',
  {
    /** UUID PK — opaque per-row identity (UUIDv7 from src/util/uuid.ts on INSERT). */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Natural key — one search row per HS-12 catalog row. UNIQUE invariant. */
    code: char('code', { length: 12 })
      .notNull()
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

    /** Ingest pipeline version (git SHA / semver). */
    buildVersion: text('build_version').notNull(),

    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUniq: unique('hs_code_search_code_uniq').on(t.code),
    // HNSW + GIN indexes declared in raw SQL (0028).
  }),
);

export type HsCodeSearchRow = typeof hsCodeSearch.$inferSelect;
export type NewHsCodeSearchRow = typeof hsCodeSearch.$inferInsert;
