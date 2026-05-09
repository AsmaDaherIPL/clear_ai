/**
 * Drizzle queries against operators, operator_field_mappings, operator_constants.
 * Pure data access — no caching, no validation. The registry layer wraps
 * these for in-memory caching.
 *
 * Children FK on operators.id (post-migration 0050). slug is kept on the
 * operators row only as a UNIQUE human-readable label.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  operators,
  operatorFieldMappings,
  type OperatorRow,
  type NewOperatorRow,
  type OperatorFieldMappingRow,
} from '../../db/schema.js';

export async function getOperatorBySlug(slug: string): Promise<OperatorRow | null> {
  const rows = await db().select().from(operators).where(eq(operators.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function getOperatorById(id: string): Promise<OperatorRow | null> {
  const rows = await db().select().from(operators).where(eq(operators.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listOperators(): Promise<OperatorRow[]> {
  return db().select().from(operators).orderBy(operators.slug);
}

export async function getMappingsByOperatorId(operatorId: string): Promise<OperatorFieldMappingRow[]> {
  return db()
    .select()
    .from(operatorFieldMappings)
    .where(eq(operatorFieldMappings.operatorId, operatorId))
    .orderBy(operatorFieldMappings.canonicalField);
}

/**
 * Insert or update an operator by slug. Returns the row in either case.
 * Used by the seed script in src/scripts/seed-operators.ts; not used at request time.
 */
export async function upsertOperator(input: NewOperatorRow): Promise<OperatorRow> {
  const existing = await getOperatorBySlug(input.slug);
  if (existing) {
    const updated = await db()
      .update(operators)
      .set({
        displayName: input.displayName,
        active: input.active ?? existing.active,
      })
      .where(eq(operators.slug, input.slug))
      .returning();
    return updated[0]!;
  }
  const inserted = await db().insert(operators).values(input).returning();
  return inserted[0]!;
}
