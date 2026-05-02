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
} from 'drizzle-orm/pg-core';

export const hsCodeDisplay = pgTable(
  'hs_code_display',
  {
    code: char('code', { length: 12 })
      .primaryKey()
      .references(() => hsCodesCodeRef, { onDelete: 'cascade' }),

    /** Cleaned own-row label (dashes stripped). e.g. "Other" for 640299000000. */
    labelEn: text('label_en').notNull(),
    labelAr: text('label_ar'),

    /** Full breadcrumb joined by " > ". e.g. "Other footwear … > Other footwear > Other". */
    pathEn: text('path_en').notNull(),
    pathAr: text('path_ar'),

    /** Ancestor codes root → self, e.g. ["640200000000","640290000000","640299000000"]. */
    pathCodes: json('path_codes').$type<string[]>().notNull(),

    /** Hierarchy depth from dash count: 0 = heading-padded, up to ~4 for product-leaves. */
    depth: smallint('depth').notNull(),

    /** LLM-polished canonical name (commit #6 / future seed script). NULL until populated. */
    submissionDescriptionEn: text('submission_description_en'),
    submissionDescriptionAr: text('submission_description_ar'),
    submissionDescModel: text('submission_desc_model'),
    submissionDescGeneratedAt: timestamp('submission_desc_generated_at', { withTimezone: true }),

    derivedAt: timestamp('derived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pathCodesGin: index('hs_code_display_path_codes_gin').on(t.pathCodes),
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
