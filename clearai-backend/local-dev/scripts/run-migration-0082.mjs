/**
 * One-off applier for migration 0082_zatca_lv_invoice_cap. Bumps
 * ZATCA_BUNDLE_SIZE 99 -> 9999 and seeds ZATCA_LV_INVOICE_CAP_SAR=1000
 * in setup_meta.
 *
 * SAFE TO RE-RUN: ON CONFLICT DO UPDATE keeps idempotency.
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

const MIGRATION_FILE = '/Users/asma/Desktop/Customs AI/clear_ai/clearai-backend/drizzle/0082_zatca_lv_invoice_cap.sql';
const MIGRATION_TAG = '0082_zatca_lv_invoice_cap';

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

    const r = await client.query(`
      SELECT key, value_numeric
        FROM setup_meta
       WHERE key IN ('ZATCA_BUNDLE_SIZE', 'ZATCA_LV_INVOICE_CAP_SAR')
       ORDER BY key
    `);
    for (const row of r.rows) {
      console.log(`  ${row.key} = ${row.value_numeric}`);
    }
    const map = Object.fromEntries(r.rows.map((row) => [row.key, Number(row.value_numeric)]));
    if (map['ZATCA_BUNDLE_SIZE'] !== 9999) {
      console.error('  VERIFICATION FAILED — ZATCA_BUNDLE_SIZE != 9999');
      process.exit(2);
    }
    if (map['ZATCA_LV_INVOICE_CAP_SAR'] !== 1000) {
      console.error('  VERIFICATION FAILED — ZATCA_LV_INVOICE_CAP_SAR != 1000');
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
