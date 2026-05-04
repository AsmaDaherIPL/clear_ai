// Owner: BatchPlumber agent.
// Expected exports:
//   CanonicalLineItem      — the normalized item shape that flows through dispatch + classification
//   TenantConfig           — { id, slug, displayName, bundleSize, hvThresholdSar, mappings, lookups }
//   ColumnMappingRule      — { sourceColumn, canonicalField, required, transform, defaultValue }
//   TransformKind          — 'trim' | 'uppercase' | 'lowercase' | null

export {};
