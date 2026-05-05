/**
 * setup_meta — typed key/value config store (gate thresholds, feature flags, token caps).
 *
 * Design (ADR-0009): `key` IS the identity — this is a config map, not an entity
 * table, so a UUID PK would be meaningless. No row is ever navigated to by opaque id.
 *
 * Column authority:
 *   value        — human-readable text mirror only. NEVER parsed at runtime for numeric
 *                  keys. Kept for operator readability when browsing rows in psql/pgAdmin.
 *   value_numeric — authoritative source for all numeric tunables. The fail-closed loader
 *                  (setup-meta.repository.ts) reads ONLY this column and throws on NULL.
 *   value_kind   — CHECK-constrained to ('number'|'string'). A DB-level consistency CHECK
 *                  enforces value_kind='number' => value_numeric IS NOT NULL.
 *
 * Booleans are encoded as 0/1 numbers (value_kind='number') because value_kind only
 * allows two types and a first-class boolean kind is not needed yet.
 */
import { pgTable, text, varchar, timestamp, doublePrecision } from 'drizzle-orm/pg-core';

export const setupMeta = pgTable('setup_meta', {
  key: varchar('key', { length: 64 }).primaryKey(),
  /** Human-readable text mirror — not parsed at runtime. See table comment above. */
  value: text('value').notNull(),
  /** Authoritative numeric value. NULL only when value_kind='string'. */
  valueNumeric: doublePrecision('value_numeric'),
  /** 'number' | 'string'. DB CHECK enforces consistency with value_numeric. */
  valueKind: varchar('value_kind', { length: 16 }).notNull().default('string'),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SetupMetaRow = typeof setupMeta.$inferSelect;
