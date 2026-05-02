/** setup_meta — typed key/value config (gate thresholds, feature flags, token caps, etc). */
import { pgTable, text, varchar, timestamp, doublePrecision } from 'drizzle-orm/pg-core';

export const setupMeta = pgTable('setup_meta', {
  key: varchar('key', { length: 64 }).primaryKey(),
  /** Human-readable text mirror. */
  value: text('value').notNull(),
  /** Authoritative for numeric kinds. */
  valueNumeric: doublePrecision('value_numeric'),
  /** 'number' | 'string'. */
  valueKind: varchar('value_kind', { length: 16 }).notNull().default('string'),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SetupMetaRow = typeof setupMeta.$inferSelect;
