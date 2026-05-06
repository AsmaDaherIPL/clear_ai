/**
 * In-memory shape of the decsub:saudiEDI envelope before serialisation.
 * Mirrors decsub.xsd structurally; the renderer translates field by field.
 */
import type { DeclarationRunItemRow } from '../../../db/schema.js';
import type { BundleStrategy } from '../../../modules/declaration-runs/filings/declaration.types.js';
import type { LookupValue } from '../../../modules/operators/operator-lookups.repository.js';
import type { OperatorIdentity } from '../../../modules/operators/operator-config.types.js';

export interface BundleInput {
  strategy: BundleStrategy;
  /** Items belonging to this bundle. HV bundles have exactly 1; LV up to bundleSize. */
  items: ReadonlyArray<DeclarationRunItemRow>;
}

export interface RenderInput {
  operator: {
    slug: string;
    displayName: string;
    /** Per-operator placeholder values — currently express_default_city / express_zip_code / express_po_box pending Naqel confirmation. */
    constants: Readonly<Record<string, string>>;
    /** Typed Tabadul identity columns from the operators row. */
    identity: Readonly<OperatorIdentity>;
  };
  /**
   * ZATCA-spec defaults read from zatca_declaration_defaults. Same for every
   * operator. Loaded once per process by zatca-defaults.repository.
   */
  zatcaDefaults: Readonly<Record<string, string>>;
  bundleStrategy: BundleStrategy;
  items: ReadonlyArray<DeclarationRunItemRow>;
  submitter: {
    carrierId: string;
    name: string;
  };
  namespaces: {
    decsub: string;
  };
  /**
   * lookup_type -> source_value -> { canonical, metadata }.
   * Provided by the runner from getLookupsByOperatorIdWithMetadata
   * (merged tabadul_codes + operator_lookups); renderer is pure.
   */
  lookups: ReadonlyMap<string, ReadonlyMap<string, LookupValue>>;
  /** Submission date (UTC); feeds airBLDate + documentDate fallbacks. */
  now: Date;
  /**
   * Test seam: override the random docRefNo suffix with a known value so
   * sample-equivalence tests can match the reference XMLs byte-for-byte.
   * Production callers leave this undefined.
   */
  docRefSuffixOverride?: string;
}

export type { BundleStrategy } from '../../../modules/declaration-runs/filings/declaration.types.js';
