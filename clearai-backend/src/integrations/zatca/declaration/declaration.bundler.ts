// Owner: BatchPlumber agent.
// Splits CanonicalLineItem[] into:
//   - HV bundles: items with value_amount >= tenant.hvThresholdSar -> 1 item per declaration
//   - LV bundles: remaining items grouped into chunks of tenant.bundleSize (default 99)

export {};
