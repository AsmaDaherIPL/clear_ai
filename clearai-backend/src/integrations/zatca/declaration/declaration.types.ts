/**
 * In-memory shape of the decsub:saudiEDI envelope before serialisation.
 * Mirrors decsub.xsd structurally; the renderer translates field by field.
 */
import type { DeclarationSetItemRow } from '../../../db/schema.js';
import type { BundleStrategy } from '../../../modules/declaration-sets/declaration/declaration.types.js';
import type { LookupValue } from '../../../modules/tenants/tenant-lookups.repository.js';

export interface BundleInput {
  strategy: BundleStrategy;
  /** Items belonging to this bundle. HV bundles have exactly 1; LV up to bundleSize. */
  items: ReadonlyArray<DeclarationSetItemRow>;
}

export interface RenderInput {
  tenant: {
    slug: string;
    displayName: string;
    constants: Readonly<Record<string, string>>;
  };
  bundleStrategy: BundleStrategy;
  items: ReadonlyArray<DeclarationSetItemRow>;
  submitter: {
    carrierId: string;
    name: string;
  };
  namespaces: {
    decsub: string;
  };
  /**
   * lookup_type -> source_value -> { canonical, metadata }.
   * Provided by the runner from getLookupsBySlugWithMetadata; renderer is
   * pure.
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

export type { BundleStrategy } from '../../../modules/declaration-sets/declaration/declaration.types.js';
