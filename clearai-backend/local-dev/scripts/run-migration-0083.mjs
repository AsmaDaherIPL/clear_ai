/**
 * One-off applier for migration 0083_sanity_verdict_drop_block. Tightens
 * the classification_events.sanity_verdict CHECK to {PASS, FLAG, NULL} and
 * rewrites historical 'BLOCK' rows to NULL.
 *
 * SAFE TO RE-RUN: DROP CONSTRAINT IF EXISTS + UPDATE-only data step.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const MIGRATION_FILE = '/Users/asma/Desktop/Customs AI/clear_ai/clearai-backend/drizzle/0083_sanity_verdict_drop_block.sql';
const MIGRATION_TAG = '0083_sanity_verdict_drop_block';

const sql = readFileSync(MIGRATION_FILE, 'utf-8');
const hash = createHash('sha256').update(sql).digest('hex');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

async function main() {
  const client = await pool.connect();
  try {
    console.log(`Applying ${MIGRATION_TAG} (hash=${hash.slice(0, 12)}...)`);

    const existing = await client.query(
      `SELECT id, created_at FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`,
      [hash],
    );
    if (existing.rowCount > 0) {
      console.log(`  Already applied (id=${existing.rows[0].id}). Nothing to do.`);
      return;
    }

    // Pre-flight: how many historical BLOCK rows are we about to rewrite?
    const pre = await client.query(
      `SELECT COUNT(*)::int AS n FROM classification_events WHERE sanity_verdict = 'BLOCK'`,
    );
    console.log(`  Historical 'BLOCK' rows to rewrite to NULL: ${pre.rows[0].n}`);

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [hash, Date.now()],
      );
      await client.query('COMMIT');
      console.log('  Migration applied + recorded.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const chk = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname = 'classification_events_sanity_verdict_check'
    `);
    const def = chk.rows[0]?.def ?? '(missing)';
    console.log(`  Constraint def: ${def}`);
    if (def.includes('BLOCK')) {
      console.error('  VERIFICATION FAILED — constraint still allows BLOCK.');
      process.exit(2);
    }
    const post = await client.query(
      `SELECT COUNT(*)::int AS n FROM classification_events WHERE sanity_verdict = 'BLOCK'`,
    );
    if (post.rows[0].n !== 0) {
      console.error(`  VERIFICATION FAILED — ${post.rows[0].n} BLOCK rows still present.`);
      process.exit(2);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
