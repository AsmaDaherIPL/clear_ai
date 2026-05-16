/**
 * One-off applier for migration 0081_hitl_decision_widen against
 * Postgres (dev + remote). Replaces the hitl_queue_reviewer_decision_check
 * constraint with one that allows 'block_from_submission' (latent fix —
 * see migration header) and 'confirm_flag' (new verb for sanity_flag-only
 * audit signalling).
 *
 * Required before:
 *   - the FIRST PATCH /classifications/review/:id with
 *     decision='block_from_submission' can commit (the route was shipped
 *     with migration 0080 but the CHECK was never widened — every block
 *     write today would fail on COMMIT)
 *   - PATCH /classifications/review/:id with decision='confirm_flag'
 *     becomes available
 *
 * SAFE TO RE-RUN: DROP CONSTRAINT IF EXISTS is idempotent. Drizzle
 * bookkeeping is gated on hash-existence check.
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

const MIGRATION_FILE = '/Users/asma/Desktop/Customs AI/clear_ai/clearai-backend/drizzle/0081_hitl_decision_widen.sql';
const MIGRATION_TAG = '0081_hitl_decision_widen';

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

    // Verify: read the new CHECK definition and confirm both new values
    // appear in the source text.
    const chk = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname = 'hitl_queue_reviewer_decision_check'
    `);
    const def = chk.rows[0]?.def ?? '(missing)';
    console.log(`  Constraint def: ${def}`);
    const hasBlock = def.includes('block_from_submission');
    const hasConfirm = def.includes('confirm_flag');
    console.log(`  Allows block_from_submission: ${hasBlock ? 'yes' : 'NO'}`);
    console.log(`  Allows confirm_flag:           ${hasConfirm ? 'yes' : 'NO'}`);
    if (!hasBlock || !hasConfirm) {
      console.error('  VERIFICATION FAILED — constraint missing expected values.');
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
