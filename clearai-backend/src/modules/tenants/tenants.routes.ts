/**
 * Admin endpoints for tenant config.
 *   GET    /tenants                  list cached tenants
 *   GET    /tenants/:slug            single tenant + mapping/constants summary
 *   POST   /tenants/:slug/refresh    invalidate cache and reload
 *
 * Editing rows is out of scope for v0 — seeds run via src/scripts/.
 */
import type { FastifyInstance } from 'fastify';
import { resolve, refresh, snapshot, warmAll } from './tenant-config.registry.js';
import { TenantNotFoundError } from './tenant.errors.js';

interface SummarisedTenant {
  slug: string;
  display_name: string;
  bundle_size: number;
  hv_threshold_sar: number;
  active: boolean;
  mapping_count: number;
  constant_count: number;
}

function summarise(c: Awaited<ReturnType<typeof resolve>>): SummarisedTenant {
  return {
    slug: c.slug,
    display_name: c.displayName,
    bundle_size: c.bundleSize,
    hv_threshold_sar: c.hvThresholdSar,
    active: c.active,
    mapping_count: c.mappings.length,
    constant_count: Object.keys(c.constants).length,
  };
}

export async function tenantsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants', async (_req, reply) => {
    let cached = snapshot();
    if (cached.length === 0) {
      // Cold start: warm from DB on first GET so the registry doesn't have to
      // be eagerly hydrated by app.ts. Idempotent.
      cached = await warmAll();
    }
    return reply.send({ tenants: cached.map(summarise) });
  });

  app.get<{ Params: { slug: string } }>('/tenants/:slug', async (req, reply) => {
    try {
      const cfg = await resolve(req.params.slug);
      return reply.send({
        tenant: summarise(cfg),
        mappings: cfg.mappings.map((m) => ({
          source_column: m.sourceColumn,
          canonical_field: m.canonicalField,
          required: m.required,
          transform: m.transform,
          default_value: m.defaultValue,
        })),
        constants: cfg.constants,
      });
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  app.post<{ Params: { slug: string } }>('/tenants/:slug/refresh', async (req, reply) => {
    try {
      const cfg = await refresh(req.params.slug);
      return reply.send({ tenant: summarise(cfg), refreshed_at: new Date().toISOString() });
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
}
