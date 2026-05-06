/**
 * Phase 2 (declaration) Drizzle queries. The `declarations` table is
 * created in migration 0044; this file imports it from the schema barrel.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  declarationRunItems,
  declarationRuns,
  declarationRunFilings,
  type DeclarationStatus,
  type DeclarationRunItemRow,
} from '../../../db/schema.js';
import type { BundleStrategy } from './declaration.types.js';

export async function listClassifiedItems(declarationRunId: string): Promise<DeclarationRunItemRow[]> {
  return db()
    .select()
    .from(declarationRunItems)
    .where(
      and(
        eq(declarationRunItems.declarationRunId, declarationRunId),
        inArray(declarationRunItems.status, ['succeeded', 'flagged']),
      ),
    )
    .orderBy(declarationRunItems.rowIndex);
}

export interface RecordDeclarationInput {
  declarationRunId: string;
  bundleIndex: number;
  strategy: BundleStrategy;
  itemCount: number;
  blobKey: string;
}

export async function recordDeclaration(input: RecordDeclarationInput): Promise<void> {
  await db().insert(declarationRunFilings).values({
    declarationRunId: input.declarationRunId,
    bundleIndex: input.bundleIndex,
    bundleStrategy: input.strategy,
    itemCount: input.itemCount,
    blobKey: input.blobKey,
    // The render+upload completed successfully before this row is recorded,
    // so the row is born in the 'generated' state. ZATCA verdict
    // (zatcaStatus + bayanNo or rejectionReason) is filled in later.
    status: 'generated',
  });
}

export async function markDeclarationPhase(
  declarationRunId: string,
  status: DeclarationStatus,
  err?: string,
): Promise<void> {
  await db()
    .update(declarationRuns)
    .set({
      declarationStatus: status,
      ...(err ? { error: err } : {}),
    })
    .where(eq(declarationRuns.id, declarationRunId));
}
