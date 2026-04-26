/**
 * Migration runner — Drizzle's built-in node-postgres migrator.
 *
 * Reads `drizzle/meta/_journal.json` to get the ordered list of migrations,
 * runs any whose `when` (epoch millis) is newer than the latest row in the
 * `drizzle.__drizzle_migrations` ledger, and records hashes so an edited
 * already-applied SQL file is detected (the previous custom runner only
 * tracked filenames and would silently miss content drift). See ADR-0010.
 *
 * Hand-authored extension/trigger SQL still lives in `drizzle/*.sql` exactly
 * as before — Drizzle's migrator runs raw SQL files; only the ledger and
 * statement-breakpoint splitting are now handled by the library rather than
 * our own code.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { getPool, closeDb } from '../db/client.js';

async function main(): Promise<void> {
  const pool = getPool();
  const db = drizzle(pool);
  const migrationsFolder = join(process.cwd(), 'drizzle');

  console.log(`Applying migrations from ${migrationsFolder} ...`);
  await migrate(db, { migrationsFolder });
  console.log('✓ migrations up to date');
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
