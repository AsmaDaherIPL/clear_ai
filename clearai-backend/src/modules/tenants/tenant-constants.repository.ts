/**
 * Read-side repository for tenant_constants.
 * Caching is the registry's job; this module is plain Drizzle.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tenantConstants } from '../../db/schema.js';

/** Returns a frozen key->value record for the tenant. */
export async function getConstantsAsRecord(slug: string): Promise<Record<string, string>> {
  const rows = await db().select().from(tenantConstants).where(eq(tenantConstants.tenant, slug));
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
