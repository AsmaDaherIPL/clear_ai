/**
 * Phase 2 implementation. Lives in a separate file from the service so
 * the entrypoint (runDeclarationPhaseIfNeeded) stays small and testable.
 *
 * Pulls every dependency the renderer needs once per batch
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
import { loadDeclarationConfig } from '../../operators/operator-declaration-config.repository.js';
import { partitionHvLv } from '../../../integrations/zatca/declaration/declaration.bundler.js';
import { renderDeclarationXml } from '../../../integrations/zatca/declaration/declaration.template.js';
import { getBlobClient } from '../../../storage/blob.client.js';
import { filingKey } from '../../../storage/blob.paths.js';
import { getBatch } from '../batch.repository.js';
import { newId } from '../../../common/utils/uuid.js';
import { loadThresholds } from '../../reference-data/setup-meta.repository.js';

export async function runDeclarationPhase(batchId: string): Promise<PhaseDeclarationSummary> {
  const startMs = Date.now();
  await markDeclarationPhase(batchId, 'running');

  const batch = await getBatch(batchId);
  const operatorRow = await getOperatorById(batch.operatorId);
  if (!operatorRow) {
    throw new Error(`operator ${batch.operatorId} not found for batch ${batchId}`);
  }
  const operator = await resolveOperator(operatorRow.slug);
  const blobPrefix = batch.blobPrefix;
  if (!blobPrefix) {
    throw new Error(
      `batch ${batchId} has no blob_prefix; runs created before 0061 cannot be re-rendered.`,
    );
  }
  const lookups = await getLookupsByOperatorIdWithMetadata(operator.id);
  const items = await listClassifiedItems(batchId);

  // setup_meta = spec-wide HV/LV tunables.
  // operator_declaration_config = per-operator render defaults (submitter,
  // envelope constants, consignee fallbacks).
  const [thresholds, config] = await Promise.all([
    loadThresholds(),
    loadDeclarationConfig(operator.id),
  ]);

  const bundles = partitionHvLv(items, {
    hvThresholdSar: thresholds.ZATCA_HV_THRESHOLD_SAR,
    bundleSize: thresholds.ZATCA_BUNDLE_SIZE,
    lvInvoiceCapSar: thresholds.ZATCA_LV_INVOICE_CAP_SAR,
  });

  const blob = getBlobClient();
  const now = new Date();

  // Submitting with an empty carrier id would produce a ZATCA-rejected
  // declaration. Fail with the operator named so an admin knows which
  // row to update.
  if (!config.zatcaSubmitterCarrierId) {
    throw new Error(
      `Operator '${operator.slug}' has no zatca_submitter_carrier_id configured. ` +
      `An admin must populate operator_declaration_config.zatca_submitter_carrier_id ` +
      `with the value assigned at the operator's ZATCA registration before declaration ` +
      `rendering can run.`,
    );
  }

  let bundleIndex = 0;
  for (const bundle of bundles) {
    const xml = renderDeclarationXml({
      operator: {
        slug: operator.slug,
        displayName: operator.displayName,
        identity: operator.identity,
      },
      config,
      bundleStrategy: bundle.strategy,
      items: bundle.items,
      lookups,
      now,
    });
    // Mint the filing id up front so the blob key (filingId.xml) and the
    // DB row PK match. The repository accepts a pre-allocated id; if it
    // didn't, we'd have to round-trip through the DB to learn the id
    // before we could write the blob.
    const filingId = newId();
    const key = filingKey({ prefix: blobPrefix, strategy: bundle.strategy, filingId });
    await blob.put(key, Buffer.from(xml, 'utf8'), 'application/xml');
    await recordDeclaration({
      filingId,
      batchId,
      bundleIndex,
      strategy: bundle.strategy,
      itemCount: bundle.items.length,
      blobKey: key,
    });
    bundleIndex++;
  }

  await markDeclarationPhase(batchId, 'completed');

  return {
    bundleCount: bundles.length,
    durationMs: Date.now() - startMs,
  };
}
