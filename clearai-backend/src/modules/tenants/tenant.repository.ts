/**
 * Drizzle queries against tenants, tenant_field_mappings, tenant_constants.
 * Pure data access — no caching, no validation. The registry layer wraps
 * these for in-memory caching.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  tenants,
  tenantFieldMappings,
  tenantConstants,
  type TenantRow,
  type NewTenantRow,
  type TenantFieldMappingRow,
  type TenantConstantRow,
} from '../../db/schema.js';

export async function getTenantBySlug(slug: string): Promise<TenantRow | null> {
  const rows = await db().select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function getTenantById(id: string): Promise<TenantRow | null> {
  const rows = await db().select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listTenants(): Promise<TenantRow[]> {
  return db().select().from(tenants).orderBy(tenants.slug);
}

export async function getMappingsBySlug(slug: string): Promise<TenantFieldMappingRow[]> {
  return db()
    .select()
    .from(tenantFieldMappings)
    .where(eq(tenantFieldMappings.tenant, slug))
    .orderBy(tenantFieldMappings.canonicalField);
}

export async function getConstantsBySlug(slug: string): Promise<TenantConstantRow[]> {
  return db().select().from(tenantConstants).where(eq(tenantConstants.tenant, slug));
}

/**
 * Insert or update a tenant by slug. Returns the row in either case.
 * Used by the seed script in src/scripts/seed-tenants.ts; not used at request time.
 */
export async function upsertTenant(input: NewTenantRow): Promise<TenantRow> {
  const existing = await getTenantBySlug(input.slug);
  if (existing) {
    const updated = await db()
      .update(tenants)
      .set({
        displayName: input.displayName,
        active: input.active ?? existing.active,
      })
      .where(eq(tenants.slug, input.slug))
      .returning();
    return updated[0]!;
  }
  const inserted = await db().insert(tenants).values(input).returning();
  return inserted[0]!;
}
