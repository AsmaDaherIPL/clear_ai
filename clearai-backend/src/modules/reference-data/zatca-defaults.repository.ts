/**
 * Read-side cache for zatca_declaration_defaults.
 *
 * These are ZATCA-spec values that fill slots in the saudiEDI envelope and
 * are the same regardless of which operator is filing. Loaded once per
 * process at first read; tests can call clearZatcaDefaultsCache() to drop.
 */
import { db } from '../../db/client.js';
import { zatcaDeclarationDefaults } from '../../db/schema.js';

let CACHE: Readonly<Record<string, string>> | null = null;

/**
 * Returns a frozen key->value map of every row in zatca_declaration_defaults.
 * Cached for the process lifetime after the first call.
 */
export async function loadZatcaDefaults(): Promise<Readonly<Record<string, string>>> {
  if (CACHE) return CACHE;
  const rows = await db().select().from(zatcaDeclarationDefaults);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  CACHE = Object.freeze(out);
  return CACHE;
}

/** Drop the cache. Tests use this; production rarely needs it. */
export function clearZatcaDefaultsCache(): void {
  CACHE = null;
}
