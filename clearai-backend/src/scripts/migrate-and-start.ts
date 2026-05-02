/**
 * Production entrypoint. Apply pending migrations, then boot the server.
 *
 * Phase 2.1 cutover (backend security review H3):
 *   The runtime app role (clearai_app) has no DDL privileges. Migrations
 *   must run as a different role (clearai_migrator) that DOES have DDL.
 *   We use a SHORT-LIVED migrator pool here, run migrations, drain the
 *   pool, and only then dynamic-import the server module which builds
 *   its own pool against the runtime DATABASE_URL.
 *
 *   When MIGRATOR_DATABASE_URL is unset we fall back to DATABASE_URL —
 *   that's the legacy behaviour and remains valid for:
 *     • Local dev (one Postgres user, one connection string)
 *     • The first deploy that introduces 0019_role_separation.sql (the
 *       env split hasn't propagated yet; the migration runs as the old
 *       admin which has DDL)
 *     • Test environments
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'node:path';

async function applyMigrations(): Promise<void> {
  // Pick the migrator URL when set, else fall back to the runtime URL.
  // We DO NOT go through src/db/client.ts here — that pool is shaped for
  // the runtime app and wires the runtime DATABASE_URL into a long-lived
  // singleton. Migrations get their own short-lived pool.
  const migratorUrl =
    process.env.MIGRATOR_DATABASE_URL && process.env.MIGRATOR_DATABASE_URL.length > 0
      ? process.env.MIGRATOR_DATABASE_URL
      : process.env.DATABASE_URL;
  if (!migratorUrl) {
    throw new Error('Neither MIGRATOR_DATABASE_URL nor DATABASE_URL is set; cannot run migrations.');
  }

  // Defensive: avoid printing the full URL (contains credentials) — only
  // the host and which env var was selected so the deploy log is debuggable
  // without leaking secrets.
  let host = '<unparseable>';
  try {
    host = new URL(migratorUrl).host;
  } catch {
    // ignore — defensive only
  }
  const which = process.env.MIGRATOR_DATABASE_URL ? 'MIGRATOR_DATABASE_URL' : 'DATABASE_URL';
  // eslint-disable-next-line no-console
  console.log(`[migrate] using ${which} (host=${host})`);

  // max=1: a single connection is plenty for sequential migrations and
  // makes the post-migration drain deterministic.
  const pool = new Pool({ connectionString: migratorUrl, max: 1 });
  try {
    const db = drizzle(pool);
    const migrationsFolder = join(process.cwd(), 'drizzle');
    // eslint-disable-next-line no-console
    console.log(`[migrate] applying from ${migrationsFolder} ...`);
    const t0 = Date.now();
    await migrate(db, { migrationsFolder });
    // eslint-disable-next-line no-console
    console.log(`[migrate] up to date (${Date.now() - t0}ms)`);
  } finally {
    // Drain the migrator pool before the server starts. The server's
    // pool is a separate long-lived singleton — leaving the migrator
    // pool open would leak a connection slot for the lifetime of the
    // process.
    await pool.end();
  }
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
