/**
 * Phase 2 (declaration) Drizzle queries. The `declarations` table is
 * created in migration 0044; this file imports it from the schema barrel.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  declarationSetItems,
  declarationSets,
  declarations,
  type DeclarationStatus,
  type DeclarationSetItemRow,
} from '../../../db/schema.js';
import type { BundleStrategy } from './declaration.types.js';

export async function listClassifiedItems(declarationSetId: string): Promise<DeclarationSetItemRow[]> {
  return db()
    .select()
    .from(declarationSetItems)
    .where(
      and(
        eq(declarationSetItems.declarationSetId, declarationSetId),
        inArray(declarationSetItems.status, ['succeeded', 'flagged']),
      ),
    )
    .orderBy(declarationSetItems.rowIndex);
}

export interface RecordDeclarationInput {
  declarationSetId: string;
  bundleIndex: number;
  strategy: BundleStrategy;
  itemCount: number;
  blobKey: string;
}

export async function recordDeclaration(input: RecordDeclarationInput): Promise<void> {
  await db().insert(declarations).values({
    declarationSetId: input.declarationSetId,
    bundleIndex: input.bundleIndex,
    bundleStrategy: input.strategy,
    itemCount: input.itemCount,
    blobKey: input.blobKey,
  });
}

export async function markDeclarationPhase(
  declarationSetId: string,
  status: DeclarationStatus,
  err?: string,
): Promise<void> {
  await db()
    .update(declarationSets)
    .set({
      declarationStatus: status,
      ...(err ? { error: err } : {}),
    })
    .where(eq(declarationSets.id, declarationSetId));
}
