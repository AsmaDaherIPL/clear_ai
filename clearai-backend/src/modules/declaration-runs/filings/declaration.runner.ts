/**
 * Phase 2 implementation. Lives in a separate file from the service so
 * the entrypoint (runDeclarationPhaseIfNeeded) stays small and testable.
 *
 * Pulls every dependency the renderer needs once per declaration_run
 * (operator config, lookups-with-metadata) and threads them into the pure
 * renderer per bundle.
 */
import {
  markDeclarationPhase,
  listClassifiedItems,
  recordDeclaration,
} from './declaration.repository.js';
import type { PhaseDeclarationSummary } from './declaration.types.js';
import { resolve as resolveOperator } from '../../operators/operator-config.registry.js';
import { getOperatorById } from '../../operators/operator.repository.js';
import { getLookupsByOperatorIdWithMetadata } from '../../operators/operator-lookups.repository.js';
import { partitionHvLv } from '../../../integrations/zatca/declaration/declaration.bundler.js';
import { renderDeclarationXml } from '../../../integrations/zatca/declaration/declaration.template.js';
import { getBlobClient } from '../../../storage/blob.client.js';
import { declarationKey } from '../../../storage/blob.paths.js';
import { getDeclarationRun } from '../declaration-run.repository.js';
import { env } from '../../../config/env.js';
import { loadThresholds } from '../../reference-data/setup-meta.repository.js';
import { loadZatcaDefaults } from '../../reference-data/zatca-defaults.repository.js';

export async function runDeclarationPhase(declarationRunId: string): Promise<PhaseDeclarationSummary> {
  const startMs = Date.now();
  await markDeclarationPhase(declarationRunId, 'running');

  const declarationRun = await getDeclarationRun(declarationRunId);
  const operatorRow = await getOperatorById(declarationRun.operatorId);
  if (!operatorRow) {
    throw new Error(`operator ${declarationRun.operatorId} not found for declaration_run ${declarationRunId}`);
  }
  const operator = await resolveOperator(operatorRow.slug);
  const lookups = await getLookupsByOperatorIdWithMetadata(operator.id);
  const items = await listClassifiedItems(declarationRunId);

  // ZATCA tunables (HV threshold, bundle size) live in setup_meta — spec-wide.
  // ZATCA envelope defaults live in zatca_declaration_defaults — also spec-wide.
  const [thresholds, zatcaDefaults] = await Promise.all([
    loadThresholds(),
    loadZatcaDefaults(),
  ]);

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
      operator: {
        slug: operator.slug,
        displayName: operator.displayName,
        constants: operator.constants,
        identity: operator.identity,
        defaultConsigneeAddress: operator.defaultConsigneeAddress,
      },
      zatcaDefaults,
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
    const key = declarationKey(declarationRunId, bundleIndex);
    await blob.put(key, Buffer.from(xml, 'utf8'), 'application/xml');
    await recordDeclaration({
      declarationRunId,
      bundleIndex,
      strategy: bundle.strategy,
      itemCount: bundle.items.length,
      blobKey: key,
    });
    bundleIndex++;
  }

  await markDeclarationPhase(declarationRunId, 'completed');

  return {
    bundleCount: bundles.length,
    durationMs: Date.now() - startMs,
  };
}
