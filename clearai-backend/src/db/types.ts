/**
 * Custom Drizzle column types used across schemas.
 *
 * - `vector(dim)` — pgvector column. Drizzle core has no built-in helper.
 *   Driver wire format: `[v1,v2,...]` (text). We mean-pool + L2-normalise
 *   embeddings before insert.
 * - `tsvector` — PostgreSQL full-text search type. Populated by triggers
 *   defined in 0001_indexes_triggers.sql; we declare the column shape only.
 */
import { customType } from 'drizzle-orm/pg-core';

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    const dim = (config as { dim?: number } | undefined)?.dim ?? 384;
    return `vector(${dim})`;
  },
  toDriver(value: number[]) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string) {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(Number);
  },
});

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});
