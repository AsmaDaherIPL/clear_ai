/**
 * Phase 2 implementation. Lives in a separate file from the service so
 * the entrypoint (runDeclarationPhaseIfNeeded) stays small and testable.
 *
 * Phase 4 ships the no-op skeleton. Phase 5 fills in the bundler + template
 * + persistence work in this file.
 */
import {
  markBatchDeclarationPhase,
  listClassifiedItems,
  recordDeclaration,
} from './batch-declaration.repository.js';
import type { PhaseDeclarationSummary } from './batch-declaration.types.js';
import { resolve as resolveTenant } from '../../tenants/tenant-config.registry.js';
import { partitionHvLv } from '../../../integrations/zatca/declaration/declaration.bundler.js';
import { renderDeclarationXml } from '../../../integrations/zatca/declaration/declaration.template.js';
import { getBlobClient } from '../../../storage/blob.client.js';
import { declarationKey } from '../../../storage/blob.paths.js';
import { getBatch } from '../batch.repository.js';
import { env } from '../../../config/env.js';

export async function runDeclarationPhase(batchId: string): Promise<PhaseDeclarationSummary> {
  const startMs = Date.now();
  await markBatchDeclarationPhase(batchId, 'running');

  const batch = await getBatch(batchId);
  const tenant = await resolveTenant(batch.tenant);
  const items = await listClassifiedItems(batchId);

  const bundles = partitionHvLv(items, {
    hvThresholdSar: tenant.hvThresholdSar,
    bundleSize: tenant.bundleSize,
  });

  const blob = getBlobClient();
  const e = env();

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
    });
    const key = declarationKey(batchId, bundleIndex);
    await blob.put(key, Buffer.from(xml, 'utf8'), 'application/xml');
    await recordDeclaration({
      batchId,
      bundleIndex,
      strategy: bundle.strategy,
      itemCount: bundle.items.length,
      blobKey: key,
    });
    bundleIndex++;
  }

  await markBatchDeclarationPhase(batchId, 'completed');

  return {
    bundleCount: bundles.length,
    durationMs: Date.now() - startMs,
  };
}
