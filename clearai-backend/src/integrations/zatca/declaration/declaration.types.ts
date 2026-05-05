/**
 * In-memory shape of the decsub:saudiEDI envelope before serialisation.
 * Mirrors decsub.xsd structurally; the renderer translates field by field.
 */
import type { BatchItemRow } from '../../../db/schema.js';
import type { BundleStrategy } from '../../../modules/batches/declaration/batch-declaration.types.js';

export interface BundleInput {
  strategy: BundleStrategy;
  /** Items belonging to this bundle. HV bundles have exactly 1; LV up to bundleSize. */
  items: ReadonlyArray<BatchItemRow>;
}

export interface RenderInput {
  tenant: {
    slug: string;
    displayName: string;
    constants: Readonly<Record<string, string>>;
  };
  bundleStrategy: BundleStrategy;
  items: ReadonlyArray<BatchItemRow>;
  submitter: {
    carrierId: string;
    name: string;
  };
  namespaces: {
    decsub: string;
  };
}

export type { BundleStrategy } from '../../../modules/batches/declaration/batch-declaration.types.js';
