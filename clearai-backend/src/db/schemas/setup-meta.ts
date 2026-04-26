/**
 * `setup_meta` — typed key/value config (Evidence Gate thresholds, RRF_K, etc).
 *
 * The `value` column is the legacy text representation (still written for
 * human readability). The authoritative value for numeric tunables is
 * `value_numeric`, with `value_kind` discriminating ('number' | 'string').
 * The fail-closed loader in `decision/setup-meta.ts` reads only the typed
 * column for numeric keys and crashes if a row is missing or malformed —
 * **never** silently substitutes a hard-coded default (see ADR-0009).
 *
 * `updated_at` is bumped automatically by a BEFORE UPDATE trigger
 * (0002_hardening.sql) so config changes are always traceable.
 */
import { pgTable, text, varchar, timestamp, doublePrecision } from 'drizzle-orm/pg-core';

export const setupMeta = pgTable('setup_meta', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value').notNull(), // legacy text mirror; humans read this
  valueNumeric: doublePrecision('value_numeric'), // authoritative for numeric kinds
  valueKind: varchar('value_kind', { length: 16 }).notNull().default('string'), // 'number' | 'string'
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SetupMetaRow = typeof setupMeta.$inferSelect;
