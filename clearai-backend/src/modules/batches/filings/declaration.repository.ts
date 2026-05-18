/**
 * Phase 2 (declaration) Drizzle queries. The `batch_filings` table is
 * imported from the schema barrel.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  batchItems,
  batches,
  batchFilings,
  filingAwbs,
  type DeclarationStatus,
  type BatchItemRow,
} from '../../../db/schema.js';
import type { BundleStrategy } from './declaration.types.js';

/**
 * Items that go into the XML for a given batch.
 *
 * Two-axis filter (defense in depth):
 *
 *   status IN ('succeeded', 'flagged')
 *     - 'succeeded' = sanity PASS, code present (clean ship).
 *     - 'flagged'   = sanity FLAG, code present. Sanity FLAG is an
 *                     informational signal for the review queue — it
 *                     NEVER blocks XML generation. Flagged rows ship.
 *
 *   excluded_from_xml = false
 *     - Reviewer-only flag set by PATCH /classifications/review/:id
 *       with decision='block_from_submission'. The block flow also
 *       flips status to 'blocked', so the status filter would catch
 *       it on its own, but checking excluded_from_xml independently
 *       means a future code path that flips this flag without
 *       changing status (e.g. SQL hotfix, batch-level operator block)
 *       still keeps the row out of the XML.
 *
 * Anything else (pending, blocked-by-anything, failed, pending_infra)
 * is out. Per ADR-0008 sanity BLOCK is being retired; until then it
 * lands on status='blocked' which both filters catch.
 */
export async function listClassifiedItems(batchId: string): Promise<BatchItemRow[]> {
  return db()
    .select()
    .from(batchItems)
    .where(
      and(
        eq(batchItems.batchId, batchId),
        inArray(batchItems.status, ['succeeded', 'flagged']),
        eq(batchItems.excludedFromXml, false),
      ),
    )
    .orderBy(batchItems.rowIndex);
}

export interface RecordDeclarationInput {
  /** Pre-allocated row id; matches the {filingId}.xml in the blob key. */
  filingId: string;
  batchId: string;
  bundleIndex: number;
  strategy: BundleStrategy;
  itemCount: number;
  blobKey: string;
  /** PR3: parent manifest. NULL when the filing spans manifests or when
   *  the bundler used the legacy per-item path with no AWB linkage. */
  manifestId?: string | null;
  /** PR3: ordered AWB ids covered by this filing. Used to populate
   *  the filing_awbs join. HV filings supply exactly one id; LV
   *  consolidated filings supply N. Empty array = legacy path with no
   *  AWB linkage. */
  awbIds?: ReadonlyArray<string>;
}

export async function recordDeclaration(input: RecordDeclarationInput): Promise<void> {
  await db().insert(batchFilings).values({
    id: input.filingId,
    batchId: input.batchId,
    manifestId: input.manifestId ?? null,
    bundleIndex: input.bundleIndex,
    bundleStrategy: input.strategy,
    itemCount: input.itemCount,
    blobKey: input.blobKey,
    // The render+upload completed successfully before this row is recorded,
    // so the row is born in the 'generated' state. ZATCA verdict
    // (zatcaStatus + bayanNo or rejectionReason) is filled in later.
    status: 'generated',
  });
  // Populate the filing_awbs join. We do this in a second statement
  // rather than a transaction because recordDeclaration is called per
  // bundle inside the runner's own loop — a failure here leaves the
  // filing row visible but with no AWB linkage, which is recoverable
  // (the SPA shows "N items" but no per-AWB breakdown). A genuine tx
  // around the runner is cleaner; left for PR4.
  const awbIds = input.awbIds ?? [];
  for (let i = 0; i < awbIds.length; i++) {
    await db().insert(filingAwbs).values({
      filingId: input.filingId,
      awbId: awbIds[i]!,
      sequence: i,
    });
  }
}

export async function markDeclarationPhase(
  batchId: string,
  status: DeclarationStatus,
  err?: string,
): Promise<void> {
  await db()
    .update(batches)
    .set({
      declarationStatus: status,
      ...(err ? { error: err } : {}),
    })
    .where(eq(batches.id, batchId));
}
