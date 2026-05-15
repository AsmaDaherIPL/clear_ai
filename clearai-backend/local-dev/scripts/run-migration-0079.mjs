/**
 * One-off applier for migration 0079_hitl_queue_reason_widen against
 * Postgres (dev + remote). Widens the hitl_queue.reason CHECK from
 * ('verdict_escalate','sanity_flag') to all four reasons the
 * orchestrator emits ('verdict_escalate','sanity_flag','low_information',
 * 'verifier_uncertain').
 *
 * Required before the first v2 row enqueues to HITL — otherwise the
 * INSERT throws a constraint violation and enqueueHitl silently swallows
 * it into a log line (best-effort semantics).
 *
 * SAFE TO RE-RUN: the migration uses DROP CONSTRAINT IF EXISTS + ADD
 * CONSTRAINT. Drizzle bookkeeping is gated on the hash-existence check.
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

const MIGRATION_FILE = '/Users/asma/Desktop/Customs AI/clear_ai/clearai-backend/drizzle/0079_hitl_queue_reason_widen.sql';
const MIGRATION_TAG = '0079_hitl_queue_reason_widen';

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

    // drizzle schema + __drizzle_migrations table already exist on any
    // DB that has run prior migrations; skip the bootstrap CREATE steps
    // because the migrator role may not have CREATE on the database.
    const existing = await client.query(
      `SELECT id, created_at FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`,
      [hash],
    );
    if (existing.rowCount > 0) {
      console.log(`  Already applied (id=${existing.rows[0].id}). Nothing to do.`);
      return;
    }

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

    // Verify: the new CHECK constraint should now accept all four reasons.
    const r = await client.query(`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'hitl_queue'
         AND c.conname = 'hitl_queue_reason_check'
    `);
    if (r.rowCount === 0) {
      console.error('  WARNING: hitl_queue_reason_check not found after migration');
    } else {
      console.log(`  CHECK definition: ${r.rows[0].def}`);
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
