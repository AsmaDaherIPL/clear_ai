/**
 * Phase 2 implementation. Lives in a separate file from the service so
 * the entrypoint (runDeclarationPhaseIfNeeded) stays small and testable.
 *
 * Pulls every dependency the renderer needs once per declaration_set
 * (tenant config, lookups-with-metadata) and threads them into the pure
 * renderer per bundle.
 */
import {
  markDeclarationPhase,
  listClassifiedItems,
  recordDeclaration,
} from './declaration.repository.js';
import type { PhaseDeclarationSummary } from './declaration.types.js';
import { resolve as resolveTenant } from '../../tenants/tenant-config.registry.js';
import { getLookupsBySlugWithMetadata } from '../../tenants/tenant-lookups.repository.js';
import { partitionHvLv } from '../../../integrations/zatca/declaration/declaration.bundler.js';
import { renderDeclarationXml } from '../../../integrations/zatca/declaration/declaration.template.js';
import { getBlobClient } from '../../../storage/blob.client.js';
import { declarationKey } from '../../../storage/blob.paths.js';
import { getDeclarationSet } from '../declaration-set.repository.js';
import { env } from '../../../config/env.js';
import { loadThresholds } from '../../reference-data/setup-meta.repository.js';

export async function runDeclarationPhase(declarationSetId: string): Promise<PhaseDeclarationSummary> {
  const startMs = Date.now();
  await markDeclarationPhase(declarationSetId, 'running');

  const declarationSet = await getDeclarationSet(declarationSetId);
  const tenant = await resolveTenant(declarationSet.tenant);
  const lookups = await getLookupsBySlugWithMetadata(tenant.slug);
  const items = await listClassifiedItems(declarationSetId);

  // ZATCA tunables live in setup_meta — they're spec-wide, not per-tenant.
  const thresholds = await loadThresholds();

  const bundles = partitionHvLv(items, {
    hvThresholdSar: thresholds.ZATCA_HV_THRESHOLD_SAR,
    bundleSize: thresholds.ZATCA_BUNDLE_SIZE,
  });

  const blob = getBlobClient();
  const e = env();
  const now = new Date();

  let bundleIndex = 0;
  for (const bundle of bundles) {
    const xml = renderDeclarationXml({
      tenant: { slug: tenant.slug, displayName: tenant.displayName, constants: tenant.constants },
      bundleStrategy: bundle.strategy,
      items: bundle.items,
      submitter: {
        carrierId: e.ZATCA_SUBMITTER_CARRIER_ID,
        name: e.ZATCA_SUBMITTER_NAME,
      },
      namespaces: { decsub: e.ZATCA_DECLARATION_NS },
      lookups,
      now,
    });
    const key = declarationKey(declarationSetId, bundleIndex);
    await blob.put(key, Buffer.from(xml, 'utf8'), 'application/xml');
    await recordDeclaration({
      declarationSetId,
      bundleIndex,
      strategy: bundle.strategy,
      itemCount: bundle.items.length,
      blobKey: key,
    });
    bundleIndex++;
  }

  await markDeclarationPhase(declarationSetId, 'completed');

  return {
    bundleCount: bundles.length,
    durationMs: Date.now() - startMs,
  };
}
