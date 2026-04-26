/**
 * Loads tunable thresholds from the `setup_meta` table.
 *
 * **Fail-closed by design (ADR-0009).** Earlier versions silently fell back to
 * hard-coded defaults when a row was missing or non-numeric. That is dangerous
 * for a batch ZATCA pipeline: a typo in a key, a wiped row, or a null
 * `value_numeric` would let the Evidence Gate pass with stale/wrong thresholds
 * with zero log signal. The loader now throws if any required key is missing
 * or has the wrong `value_kind`. The migration `0002_hardening.sql` seeds the
 * required rows and a CHECK constraint guarantees `value_numeric IS NOT NULL`
 * whenever `value_kind = 'number'`.
 *
 * Cached for the process lifetime; call `clearSetupMetaCache()` in tests when
 * changing values.
 */
import { getPool } from '../db/client.js';

export interface Thresholds {
  MIN_SCORE_describe: number;
  MIN_GAP_describe: number;
  MIN_SCORE_expand: number;
  MIN_GAP_expand: number;
  MIN_SCORE_boost: number;
  MIN_GAP_boost: number;
  BOOST_MARGIN: number;
  RRF_K: number;
}

const REQUIRED_NUMERIC_KEYS: ReadonlyArray<keyof Thresholds> = [
  'MIN_SCORE_describe',
  'MIN_GAP_describe',
  'MIN_SCORE_expand',
  'MIN_GAP_expand',
  'MIN_SCORE_boost',
  'MIN_GAP_boost',
  'BOOST_MARGIN',
  'RRF_K',
];

let _cache: Thresholds | null = null;

interface SetupMetaDbRow {
  key: string;
  value_numeric: number | null;
  value_kind: string;
}

export async function loadThresholds(): Promise<Thresholds> {
  if (_cache) return _cache;
  const pool = getPool();
  const r = await pool.query<SetupMetaDbRow>(
    `SELECT key, value_numeric, value_kind FROM setup_meta WHERE key = ANY($1::text[])`,
    [REQUIRED_NUMERIC_KEYS as unknown as string[]]
  );
  const map = new Map<string, SetupMetaDbRow>(r.rows.map((row) => [row.key, row]));

  const result: Partial<Thresholds> = {};
  const missing: string[] = [];
  const malformed: string[] = [];

  for (const key of REQUIRED_NUMERIC_KEYS) {
    const row = map.get(key);
    if (!row) {
      missing.push(key);
      continue;
    }
    if (row.value_kind !== 'number' || row.value_numeric === null || !Number.isFinite(row.value_numeric)) {
      malformed.push(`${key}(kind=${row.value_kind}, value_numeric=${row.value_numeric})`);
      continue;
    }
    result[key] = row.value_numeric;
  }

  if (missing.length > 0 || malformed.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing keys: ${missing.join(', ')}`);
    if (malformed.length > 0) parts.push(`malformed keys: ${malformed.join(', ')}`);
    throw new Error(
      `setup_meta is not configured correctly — ${parts.join('; ')}. ` +
        `Run \`pnpm db:migrate\` to seed defaults, or fix the rows manually. ` +
        `The Evidence Gate refuses to operate on silent defaults (ADR-0009).`
    );
  }

  _cache = result as Thresholds;
  return _cache;
}

export function clearSetupMetaCache(): void {
  _cache = null;
}
