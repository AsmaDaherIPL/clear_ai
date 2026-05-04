// Owner: BatchPlumber agent.
// THE single generic mapper. Signature:
//   mapRowToCanonical(rawRow, mappings, lookups) -> CanonicalLineItem
// Applies transforms, runs tenant_lookups for currency/country/etc,
// fills defaults, throws RequiredFieldMissingError on required-field omissions.
// CRITICAL: zero per-tenant code. Naqel-specific behavior is data, not logic.

export {};
