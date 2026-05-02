/**
 * hs_code_display — derived display + explainability data, one row per
 * hs_codes row. See 0027_hs_code_display.sql + ADR-0025 for the rationale.
 *
 * Source-of-truth split:
 *   • hs_codes        — verbatim ZATCA strings (audit, legal record)
 *   • hs_code_display — derived clean labels, breadcrumb paths, flags
 *   • hs_code_search  — search index (separate table, commit #4)
 *
 * Population: src/scripts/ingest-hs-code-display.ts (idempotent — safe
 * to re-run after a re-ingest of hs_codes).
 */
import {
  pgTable,
  char,
  text,
  smallint,
  timestamp,
  json,
  index,
  uuid,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const hsCodeDisplay = pgTable(
  'hs_code_display',
  {
    /**
     * UUID PK — opaque per-row identity. Application code generates UUIDv7
     * via newId() (src/util/uuid.ts) for new INSERTs; the DB default
     * gen_random_uuid() (UUIDv4) is the safety net.
     */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /**
     * Natural key — one row per HS-12 catalog row. UNIQUE so the 1:1
     * invariant is enforced; the FK back to hs_codes(code) cascades
     * deletes so this table never holds orphaned rows.
     */
    code: char('code', { length: 12 })
      .notNull()
      .references(() => hsCodesCodeRef, { onDelete: 'cascade' }),

    /** Cleaned own-row label (dashes + trailing punctuation stripped). */
    labelEn: text('label_en').notNull(),
    labelAr: text('label_ar'),

    /** Full breadcrumb joined by " > ". */
    pathEn: text('path_en').notNull(),
    pathAr: text('path_ar'),

    /** Ancestor codes root → self, e.g. ["640200000000","640290000000","640299000000"]. */
    pathCodes: json('path_codes').$type<string[]>().notNull(),

    /** Hierarchy depth from dash count: 0 = heading-padded, up to ~4 for product-leaves. */
    depth: smallint('depth').notNull(),

    /** LLM-polished canonical name. NULL until populated by the lazy-fill helper. */
    submissionDescriptionEn: text('submission_description_en'),
    submissionDescriptionAr: text('submission_description_ar'),
    submissionDescModel: text('submission_desc_model'),
    submissionDescGeneratedAt: timestamp('submission_desc_generated_at', { withTimezone: true }),

    derivedAt: timestamp('derived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pathCodesGin: index('hs_code_display_path_codes_gin').on(t.pathCodes),
    codeUniq: unique('hs_code_display_code_uniq').on(t.code),
  }),
);

export type HsCodeDisplayRow = typeof hsCodeDisplay.$inferSelect;
export type NewHsCodeDisplayRow = typeof hsCodeDisplay.$inferInsert;

// Local FK reference. Imported circularly from the hs-codes schema would
// create a cycle, so we declare the column shape inline. The runtime FK
// is enforced by the migration's REFERENCES clause; this is purely for
// Drizzle's type-time graph.
import { hsCodes } from './hs-codes.js';
const hsCodesCodeRef = hsCodes.code;
