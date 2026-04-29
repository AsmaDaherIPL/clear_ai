/**
 * Production entrypoint — apply pending Drizzle migrations, then boot the
 * Fastify server.
 *
 * Why this exists:
 *   The fail-closed setup_meta loader (ADR-0009) requires every key the code
 *   references to exist in the DB. A new release that adds keys (e.g. 0003's
 *   BEST_EFFORT_*) will crash-loop on boot if the SQL hasn't run yet. Wiring
 *   migrations into the container start makes "deploy code" and "migrate
 *   schema" one atomic step, with no separate manual checklist.
 *
 * Why this is safe to run on every cold start:
 *   Drizzle's migrator (`drizzle/meta/_journal.json` + `__drizzle_migrations`
 *   ledger, ADR-0010) is idempotent — already-applied migrations are skipped
 *   by hash. Two replicas booting concurrently both succeed: the migrator
 *   takes a Postgres advisory lock for the duration of pending statements,
 *   so the second replica waits, then sees nothing to apply.
 *
 * Behaviour on failure:
 *   We exit non-zero. Container Apps will mark the revision unhealthy and
 *   keep serving the previous revision — much better than booting with
 *   stale schema and 500'ing under load.
 *
 * Local dev still uses `pnpm dev` (no migration step) and `pnpm db:migrate`
 * (manual). This file is only the production CMD.
 */
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

// Hand off to the regular server entry. Side-effecting import: server/app.ts
// listens at import time. We do NOT close the pool between the migrator and
// the server — `getPool()` is a singleton, so the same connections are reused.
await import('../server/app.js');
