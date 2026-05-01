/** Apply pending Drizzle migrations from drizzle/. */
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
