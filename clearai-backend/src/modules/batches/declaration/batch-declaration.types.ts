/**
 * Phase 2 (declaration) result types.
 */
export type BundleStrategy = 'HV_STANDALONE' | 'LV_BUNDLED';

export interface DeclarationOutcome {
  bundleIndex: number;
  strategy: BundleStrategy;
  itemCount: number;
  blobKey: string;
}

export interface PhaseDeclarationSummary {
  bundleCount: number;
  durationMs: number;
}
