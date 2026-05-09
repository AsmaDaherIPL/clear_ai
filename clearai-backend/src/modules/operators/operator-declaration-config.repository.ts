import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { operatorDeclarationConfig, type OperatorDeclarationConfigRow } from '../../db/schema.js';

export class OperatorDeclarationConfigNotFoundError extends Error {
  readonly code = 'operator_declaration_config_not_found';
  constructor(operatorId: string) {
    super(`No operator_declaration_config row for operator ${operatorId}`);
    this.name = 'OperatorDeclarationConfigNotFoundError';
  }
}

export async function loadDeclarationConfig(operatorId: string): Promise<OperatorDeclarationConfigRow> {
  const rows = await db()
    .select()
    .from(operatorDeclarationConfig)
    .where(eq(operatorDeclarationConfig.operatorId, operatorId))
    .limit(1);
  if (!rows[0]) throw new OperatorDeclarationConfigNotFoundError(operatorId);
  return rows[0];
}
