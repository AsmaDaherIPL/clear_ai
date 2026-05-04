// Owner: dispatch-flow agent.
// Stage 0+1 of the v2 pipeline:
//   - check merchant_code shape (12-digit / partial / unknown / none)
//   - DB lookup against zatca-hs-codes + zatca-deleted-codes
//   - emit MerchantCodeStatus signal (NOT a routing decision — every status
//     still goes through Stage 2A blind classify)

export {};
