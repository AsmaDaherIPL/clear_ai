/**
 * submission_descriptions repository — lookup + upsert + hit-count bump.
 *
 * The table is a memo store keyed on (path_ar, cleaned_description_norm).
 * See drizzle/0058_submission_descriptions.sql + ADR for the design.
 *
 * All three operations are intentionally non-throwing on the hot path —
 * a DB hiccup must NOT block the pipeline. The caller treats `find()
 * returning null` as a cache miss, and `upsert()` / `bumpHit()` are
 * fire-and-forget.
 */
import { sql, eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  submissionDescriptions,
  type SubmissionDescriptionRow,
} from '../../../db/schema.js';

/**
 * NFKC + lowercase + collapse-whitespace normalisation. The same value is
 * applied at lookup time and at write time so casing / whitespace / NBSP
 * variations all converge on one cache entry per semantic input.
 *
 * Exported for use in submission-description.ts (single source of truth).
 */
export function normalizeForCache(input: string): string {
  return input.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Look up a memoized submission description.
 *
 * Returns the row when there's a hit (fresh row, NOT yet hit-bumped — the
 * caller decides when to bump so we don't double-bump on the rare race),
 * or null on miss / DB failure.
 */
export async function findCached(
  pathAr: string,
  cleanedDescriptionNorm: string,
): Promise<SubmissionDescriptionRow | null> {
  if (!pathAr || !cleanedDescriptionNorm) return null;
  try {
    const rows = await db()
      .select()
      .from(submissionDescriptions)
      .where(
        and(
          eq(submissionDescriptions.pathAr, pathAr),
          eq(submissionDescriptions.cleanedDescriptionNorm, cleanedDescriptionNorm),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  } catch {
    // DB hiccup — degrade silently to cache miss. The pipeline will fall
    // through to the LLM call as if the row didn't exist.
    return null;
  }
}

/**
 * Upsert a freshly-LLM-generated row. Idempotent via the
 * (path_ar, cleaned_description_norm) UNIQUE constraint: a write that
 * collides on the key is converted to a no-op rather than failing or
 * overwriting an established entry. (We trust the existing entry — both
 * are LLM output for the same inputs; collisions in production are
 * benign.)
 *
 * Fire-and-forget: returns a promise but the caller ignores it. Failures
 * are swallowed so a cache-write hiccup never poisons a successful
 * pipeline run.
 */
export async function upsertCached(params: {
  pathAr: string;
  cleanedDescriptionNorm: string;
  cleanedDescriptionRaw: string;
  descriptionAr: string;
  source: string;
  model: string | null;
}): Promise<void> {
  try {
    await db()
      .insert(submissionDescriptions)
      .values({
        pathAr: params.pathAr,
        cleanedDescriptionNorm: params.cleanedDescriptionNorm,
        cleanedDescriptionRaw: params.cleanedDescriptionRaw,
        descriptionAr: params.descriptionAr,
        source: params.source,
        model: params.model,
      })
      .onConflictDoNothing({
        target: [
          submissionDescriptions.pathAr,
          submissionDescriptions.cleanedDescriptionNorm,
        ],
      });
  } catch {
    /* swallow */
  }
}

/**
 * Increment hit_count + last_hit_at on a cache hit. Fire-and-forget:
 * the read itself already returned to the caller. Failures swallowed.
 */
export async function bumpHit(rowId: string): Promise<void> {
  try {
    await db()
      .update(submissionDescriptions)
      .set({
        hitCount: sql`${submissionDescriptions.hitCount} + 1`,
        lastHitAt: sql`now()`,
      })
      .where(eq(submissionDescriptions.id, rowId));
  } catch {
    /* swallow */
  }
}
