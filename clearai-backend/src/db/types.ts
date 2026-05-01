/** Custom Drizzle column types: pgvector and tsvector. */
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
