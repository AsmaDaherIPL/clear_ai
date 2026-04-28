/**
 * Loads tunable thresholds from the `setup_meta` table.
 *
 * **Fail-closed by design (ADR-0009).** Earlier versions silently fell back to
 * hard-coded defaults when a row was missing or non-numeric. That is dangerous
 * for a batch ZATCA pipeline: a typo in a key, a wiped row, or a null
 * `value_numeric` would let the Evidence Gate pass with stale/wrong thresholds
 * with zero log signal. The loader throws if any required key is missing or
 * has the wrong `value_kind`. The seed migration (`0001_indexes_triggers.sql`
 * + `0002_hardening.sql`) seeds the required rows and a CHECK constraint
 * guarantees `value_numeric IS NOT NULL` whenever `value_kind = 'number'`.
 *
 * Booleans are stored as numbers (0 = false, 1 = true) because the
 * `setup_meta_value_kind_chk` CHECK constraint only allows `'number'|'string'`.
 * Helpers are provided so route code reads `t.BEST_EFFORT_ENABLED === 1` as
 * an intent-revealing comparison.
 *
 * Cached for the process lifetime; call `clearSetupMetaCache()` in tests when
 * changing values.
 */
import { getPool } from '../db/client.js';

export interface Thresholds {
  // Evidence-gate per-endpoint floors (ADR-0002).
  MIN_SCORE_describe: number;
  MIN_GAP_describe: number;
  MIN_SCORE_expand: number;
  MIN_GAP_expand: number;
  MIN_SCORE_boost: number;
  MIN_GAP_boost: number;
  BOOST_MARGIN: number;
  RRF_K: number;

  /**
   * Maximum distinct HS-2 chapters tolerated among the top-N retrieved
   * candidates before we treat the input as "not understood" and route to
   * the LLM researcher. Coherent products cluster in 1–2 chapters; ambiguous
   * or jargon-heavy inputs scatter across many. Tune up to be more permissive
   * (fewer researcher calls), tune down to catch more borderline cases.
   */
  UNDERSTOOD_MAX_DISTINCT_CHAPTERS: number;

  /** Window size for the chapter-coherence check (top-N candidates). Default 5. */
  UNDERSTOOD_TOP_K_describe: number;

  /** Number of candidates pulled from pgvector + lexical RRF for /describe. Default 12. */
  RETRIEVAL_TOP_K_describe: number;

  /** Number of candidates fed to the picker for /describe. Default 8. */
  PICKER_CANDIDATES_describe: number;

  /** Number of alternatives surfaced to the user for /describe. Default 5. */
  ALTERNATIVES_SHOWN_describe: number;

  /** Cap on tokens the researcher may emit. Default 250 (JSON output, not prose). */
  RESEARCHER_MAX_TOKENS: number;

  /** Cap on tokens the best-effort fallback may emit. Default 200. */
  BEST_EFFORT_MAX_TOKENS: number;

  /**
   * Best-effort fallback feature flag. 0 = disabled (route returns
   * needs_clarification on hard cases); 1 = enabled (route attempts a
   * 4-digit best-effort heading with confidence_band='low'). Default 1.
   */
  BEST_EFFORT_ENABLED: number;

  /**
   * Maximum specificity (digit count) for best-effort fallback codes. Must be
   * one of {2, 4, 6, 8, 10}. Default 4 — chapter-heading granularity, the
   * least-harmful fallback.
   */
  BEST_EFFORT_MAX_DIGITS: number;

  /**
   * Absolute RRF score floor for surfaced alternatives. Anything below this
   * is dropped from the user-facing list regardless of relative rank — RRF
   * rescales the long tail upward, so without an absolute floor users see
   * "Bathing headgear at 80%" listed alongside genuine matches simply
   * because nothing better was left in the catalog. Default 0.55.
   */
  MIN_ALT_SCORE: number;

  /**
   * Cross-chapter ratio against the top retrieval score. A cross-chapter
   * candidate only survives if `score >= topScore * STRONG_ALT_RATIO`.
   * 0.95 means "must be within 5% of the top score" — i.e. a genuine
   * near-tie, not just "above some absolute number". This lets a real
   * cross-chapter sibling through (wired vs wireless headphones both
   * score ~1.0) while killing rows that share a single token with the
   * query but score meaningfully below the top. Default 0.95.
   */
  STRONG_ALT_RATIO: number;

  /**
   * Prefix length (in digits) to enumerate as the branch under an accepted
   * chosen code. Must be one of {4, 6, 8} where 4 = heading, 6 = subheading,
   * 8 = national subheading. Default 8 — testing showed HS-6 mixes
   * structurally-related but commercially-distinct families (e.g. wireless
   * headphones lumped with telephone exchange equipment under 8517.62);
   * HS-8 keeps comparisons within the same national-leaf family.
   */
  BRANCH_PREFIX_LENGTH: number;

  /**
   * Hard cap on leaves returned by branch enumeration. Default 50. Lets us
   * keep response payloads bounded even when an HS-4 enumeration drags in
   * 100+ leaves in dense headings.
   */
  BRANCH_MAX_LEAVES: number;
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
  'RESEARCHER_MAX_TOKENS',
  'BEST_EFFORT_MAX_TOKENS',
  'BEST_EFFORT_ENABLED',
  'BEST_EFFORT_MAX_DIGITS',
  'MIN_ALT_SCORE',
  'STRONG_ALT_RATIO',
  'BRANCH_PREFIX_LENGTH',
  'BRANCH_MAX_LEAVES',
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
        `Run \`pnpm db:migrate\` to seed defaults, or fix the rows manually. ` +
        `The Evidence Gate refuses to operate on silent defaults (ADR-0009).`,
    );
  }

  // Defensive: BEST_EFFORT_MAX_DIGITS must be one of the canonical HS levels.
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
