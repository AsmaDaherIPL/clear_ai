/**
 * submission_descriptions — memoized output of Stage 2.5 (submission
 * description LLM). See drizzle/0058_submission_descriptions.sql for the
 * design rationale.
 *
 * Lookup key: (path_ar, cleaned_description_norm).
 *   - path_ar comes from zatca_hs_code_display.path_ar (the LLM's
 *     conditioning context — semantically the actual input, not the
 *     12-digit code).
 *   - cleaned_description_norm is NFKC + lowercase + collapse-whitespace
 *     applied to the user's cleaned description.
 *
 * Cross-operator: NOT keyed on operator. Two operators classifying the
 * same input to the same path share the same row — the LLM's output is
 * conditioned on catalog text, not operator preference.
 *
 * Write policy: only INSERTed when submission-description.ts returned
 * invoked='llm'. Deterministic fallbacks are cheap to recompute and
 * would pollute the lookup.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const submissionDescriptions = pgTable(
  'submission_descriptions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** zatca_hs_code_display.path_ar for the chosen HS code. */
    pathAr: text('path_ar').notNull(),

    /** NFKC + lowercase + whitespace-collapsed cleaned_description. Lookup key. */
    cleanedDescriptionNorm: text('cleaned_description_norm').notNull(),

    /** Raw cleaned_description retained for debugging only. Not part of the key. */
    cleanedDescriptionRaw: text('cleaned_description_raw').notNull(),

    /** The cached AR submission description. */
    descriptionAr: text('description_ar').notNull(),

    /** 'llm' | 'fallback' — only 'llm' is written today. See ADR. */
    source: text('source').notNull(),

    /** Foundry deployment name that generated this row, e.g. 'claude-haiku-4-5-clearai-dev'. */
    model: text('model'),

    /** Bumped on every read-hit. Lets us see which entries are actually used. */
    hitCount: integer('hit_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
  },
  (t) => ({
    /** Composite UNIQUE — also serves as the lookup index. */
    pathInputUniq: unique('submission_descriptions_uniq').on(
      t.pathAr,
      t.cleanedDescriptionNorm,
    ),
  }),
);

export type SubmissionDescriptionRow = typeof submissionDescriptions.$inferSelect;
export type NewSubmissionDescriptionRow = typeof submissionDescriptions.$inferInsert;
