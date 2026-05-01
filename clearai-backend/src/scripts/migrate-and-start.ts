/** Production entrypoint. Apply pending migrations, then boot the server. */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { getPool } from '../db/client.js';

async function applyMigrations(): Promise<void> {
  const pool = getPool();
  const db = drizzle(pool);
  const migrationsFolder = join(process.cwd(), 'drizzle');
  // eslint-disable-next-line no-console
  console.log(`[migrate] applying from ${migrationsFolder} ...`);
  const t0 = Date.now();
  await migrate(db, { migrationsFolder });
  // eslint-disable-next-line no-console
  console.log(`[migrate] up to date (${Date.now() - t0}ms)`);
}

try {
  await applyMigrations();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[migrate] FAILED — refusing to start server', err);
  process.exit(1);
}

// Side-effecting import — server/app.ts listens at import time.
await import('../server/app.js');
