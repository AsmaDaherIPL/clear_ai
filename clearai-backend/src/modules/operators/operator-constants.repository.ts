/**
 * Read-side repository for operator_constants.
 * Caching is the registry's job; this module is plain Drizzle.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { operatorConstants } from '../../db/schema.js';

/** Returns a frozen key->value record for the operator. */
export async function getConstantsAsRecord(slug: string): Promise<Record<string, string>> {
  const rows = await db().select().from(operatorConstants).where(eq(operatorConstants.operatorSlug, slug));
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
