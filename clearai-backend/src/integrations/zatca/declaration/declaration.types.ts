/**
 * In-memory shape of the decsub:saudiEDI envelope before serialisation.
 * Mirrors decsub.xsd structurally; the renderer translates field by field.
 */
import type { DeclarationRunItemRow, OperatorDeclarationConfigRow } from '../../../db/schema.js';
import type { BundleStrategy } from '../../../modules/declaration-runs/filings/declaration.types.js';
import type { LookupValue } from '../../../modules/operators/operator-lookups.repository.js';
import type { OperatorIdentity } from '../../../modules/operators/operator-config.types.js';

export interface BundleInput {
  strategy: BundleStrategy;
  items: ReadonlyArray<DeclarationRunItemRow>;
}

export interface RenderInput {
  operator: {
    slug: string;
    displayName: string;
    constants: Readonly<Record<string, string>>;
    identity: Readonly<OperatorIdentity>;
  };
  /**
   * Per-operator render config. Holds ZATCA submitter credentials,
   * envelope constants, and consignee-address fallbacks. Replaces the
   * old separate `submitter`/`zatcaDefaults`/`defaultConsigneeAddress`
   * inputs (0063).
   */
  config: Readonly<OperatorDeclarationConfigRow>;
  bundleStrategy: BundleStrategy;
  items: ReadonlyArray<DeclarationRunItemRow>;
  /** lookup_type -> source_value -> { canonical, metadata }. */
  lookups: ReadonlyMap<string, ReadonlyMap<string, LookupValue>>;
  now: Date;
  /** Test seam: override the random docRefNo suffix for sample-equivalence tests. */
  docRefSuffixOverride?: string;
}

export type { BundleStrategy } from '../../../modules/declaration-runs/filings/declaration.types.js';
