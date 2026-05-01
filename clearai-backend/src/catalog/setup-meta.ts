/**
 * Loads tunable thresholds from `setup_meta`. Fail-closed: throws on any
 * missing key, wrong value_kind, or malformed numeric. Process-lifetime cache.
 */
import { getPool } from '../db/client.js';

export interface Thresholds {
  /** Evidence-gate per-endpoint floors. */
  MIN_SCORE_describe: number;
  MIN_GAP_describe: number;
  MIN_SCORE_expand: number;
  MIN_GAP_expand: number;
  MIN_SCORE_boost: number;
  MIN_GAP_boost: number;
  BOOST_MARGIN: number;
  RRF_K: number;

  /** Max distinct HS-2 chapters in top-N before treating input as "not understood". */
  UNDERSTOOD_MAX_DISTINCT_CHAPTERS: number;
  /** Window size for the chapter-coherence check. */
  UNDERSTOOD_TOP_K_describe: number;
  /** Candidates pulled from pgvector + RRF for /describe. */
  RETRIEVAL_TOP_K_describe: number;
  /** Candidates fed to the picker for /describe. */
  PICKER_CANDIDATES_describe: number;
  /** Alternatives surfaced to the user for /describe. */
  ALTERNATIVES_SHOWN_describe: number;
  /** Minimum non-chosen alternatives; branch enumerator widens to satisfy. */
  ALTERNATIVES_MIN_SHOWN: number;

  RESEARCHER_MAX_TOKENS: number;
  BEST_EFFORT_MAX_TOKENS: number;
  /** 0 = disabled (route returns needs_clarification); 1 = enabled. */
  BEST_EFFORT_ENABLED: number;
  /** Must be one of {2, 4, 6, 8, 10}. */
  BEST_EFFORT_MAX_DIGITS: number;

  /** Absolute RRF floor for user-facing alternatives. */
  MIN_ALT_SCORE: number;
  /** Cross-chapter rows must score at least topScore * this. */
  STRONG_ALT_RATIO: number;
  /** Branch enumeration prefix length. One of {4, 6, 8}. */
  BRANCH_PREFIX_LENGTH: number;
  BRANCH_MAX_LEAVES: number;

  MERCHANT_CLEANUP_ENABLED: number;
  MERCHANT_CLEANUP_MAX_TOKENS: number;

  BRANCH_RANK_ENABLED: number;
  BRANCH_RANK_MAX_TOKENS: number;

  SUBMISSION_DESC_ENABLED: number;
  SUBMISSION_DESC_MAX_TOKENS: number;

  BROKER_MAPPING_ENABLED: number;

  RESEARCH_WEB_ENABLED: number;
  RESEARCH_WEB_MAX_TOKENS: number;
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
  'UNDERSTOOD_MAX_DISTINCT_CHAPTERS',
  'UNDERSTOOD_TOP_K_describe',
  'RETRIEVAL_TOP_K_describe',
  'PICKER_CANDIDATES_describe',
  'ALTERNATIVES_SHOWN_describe',
  'ALTERNATIVES_MIN_SHOWN',
  'RESEARCHER_MAX_TOKENS',
  'BEST_EFFORT_MAX_TOKENS',
  'BEST_EFFORT_ENABLED',
  'BEST_EFFORT_MAX_DIGITS',
  'MIN_ALT_SCORE',
  'STRONG_ALT_RATIO',
  'BRANCH_PREFIX_LENGTH',
  'BRANCH_MAX_LEAVES',
  'MERCHANT_CLEANUP_ENABLED',
  'MERCHANT_CLEANUP_MAX_TOKENS',
  'BRANCH_RANK_ENABLED',
  'BRANCH_RANK_MAX_TOKENS',
  'SUBMISSION_DESC_ENABLED',
  'SUBMISSION_DESC_MAX_TOKENS',
  'BROKER_MAPPING_ENABLED',
  'RESEARCH_WEB_ENABLED',
  'RESEARCH_WEB_MAX_TOKENS',
];

/** Closed set of boolean flag names. Encoded as 0/1 in setup_meta.value_numeric. */
export type BooleanFlag =
  | 'BEST_EFFORT_ENABLED'
  | 'MERCHANT_CLEANUP_ENABLED'
  | 'BRANCH_RANK_ENABLED'
  | 'SUBMISSION_DESC_ENABLED'
  | 'BROKER_MAPPING_ENABLED'
  | 'RESEARCH_WEB_ENABLED';

export function isEnabled(t: Thresholds, flag: BooleanFlag): boolean {
  return t[flag] === 1;
}

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
    [REQUIRED_NUMERIC_KEYS as unknown as string[]],
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
    if (
      row.value_kind !== 'number' ||
      row.value_numeric === null ||
      !Number.isFinite(row.value_numeric)
    ) {
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
        `Run \`pnpm db:migrate\` to seed defaults, or fix the rows manually.`,
    );
  }

  const allowedDigits = new Set([2, 4, 6, 8, 10]);
  if (!allowedDigits.has(result.BEST_EFFORT_MAX_DIGITS!)) {
    throw new Error(
      `setup_meta.BEST_EFFORT_MAX_DIGITS must be one of {2,4,6,8,10}; got ${result.BEST_EFFORT_MAX_DIGITS}.`,
    );
  }

  _cache = result as Thresholds;
  return _cache;
}

export function clearSetupMetaCache(): void {
  _cache = null;
}
