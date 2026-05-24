/**
 * Operator-scoped pipeline config — the per-operator switches that
 * drive pipeline behaviour per row. Today this is just
 * `overrides_enabled` (whether the operator's curated code-override
 * table is consulted by the codebook walk).
 *
 * Lives in `catalog/` alongside the codebook lookup so both
 * orchestrators (legacy + anchored) share the helper without the
 * anchored orchestrator importing from legacy code.
 */
import { getPool } from '../../../db/client.js';

export interface OperatorPipelineConfig {
  /** Defaults to true when no operator_declaration_config row exists yet. */
  overridesEnabled: boolean;
  /**
   * When false, the orchestrator skips the sanity LLM call entirely.
   * Default true. See migration 0092 for the motivation (sanity is ~70%
   * of Sonnet cost per row and audit-only for LV-catch-all operators).
   */
  sanityEnabled: boolean;
}

export async function loadOperatorPipelineConfig(
  operatorSlug: string,
): Promise<OperatorPipelineConfig> {
  const pool = getPool();
  const r = await pool.query<{
    overrides_enabled: boolean | null;
    sanity_enabled: boolean | null;
  }>(
    `SELECT c.overrides_enabled, c.sanity_enabled
       FROM operator_declaration_config c
       JOIN operators o ON o.id = c.operator_id
      WHERE o.slug = $1`,
    [operatorSlug],
  );
  const row = r.rows[0];
  return {
    overridesEnabled: row?.overrides_enabled ?? true,
    sanityEnabled: row?.sanity_enabled ?? true,
  };
}
