/**
 * In-memory shape of the decsub:saudiEDI envelope before serialisation.
 * Mirrors decsub.xsd structurally; the renderer translates field by field.
 */
import type { BatchItemRow, OperatorDeclarationConfigRow } from '../../../db/schema.js';
import type { BundleStrategy } from '../../../modules/batches/filings/declaration.types.js';
import type { LookupValue } from '../../../modules/operators/operator-lookups.repository.js';
import type { OperatorIdentity } from '../../../modules/operators/operator-config.types.js';

export interface BundleInput {
  strategy: BundleStrategy;
  items: ReadonlyArray<BatchItemRow>;
}

export interface RenderInput {
  operator: {
    slug: string;
    displayName: string;
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
  items: ReadonlyArray<BatchItemRow>;
  /**
   * Source rows whose AWBs should appear in `<exportAirBL>` even when
   * they had no classifiable item. Use case: HITL-failed rows still
   * represent shipments physically on the flight, so customs needs to
   * see the AWB on the declaration's BL roster even though no `<item>`
   * is emitted for them.
   *
   * Optional — when absent, `<exportAirBL>` falls back to deriving the
   * BL list from `items[]` (the historical behaviour). When present,
   * the renderer prefers this list (deduped by waybillNo) and ignores
   * the items-derived set. Pass the same `items` array if you don't
   * want HITL inclusion.
   */
  allBlSources?: ReadonlyArray<BatchItemRow>;
  /** lookup_type -> source_value -> { canonical, metadata }. */
  lookups: ReadonlyMap<string, ReadonlyMap<string, LookupValue>>;
  now: Date;
  /** Test seam: override the random docRefNo suffix for sample-equivalence tests. */
  docRefSuffixOverride?: string;
}

export type { BundleStrategy } from '../../../modules/batches/filings/declaration.types.js';
