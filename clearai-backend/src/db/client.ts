import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: env().DATABASE_URL, max: 10 });
  return _pool;
}

export function db() {
  if (_db) return _db;
  _db = drizzle(getPool(), { schema });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
