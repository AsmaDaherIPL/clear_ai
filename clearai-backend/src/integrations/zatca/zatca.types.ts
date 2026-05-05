/**
 * Shared ZATCA-domain types. Kept narrow: only types that cross integration
 * boundaries live here. Bundle and envelope shapes live next to their
 * renderers in declaration/.
 */

/** ZATCA port code, e.g. 'SAJED' for Jeddah, 'SARUH' for Riyadh. */
export type PortCode = string;

/** ZATCA registered destination port code. Same shape as PortCode. */
export type RegPortCode = string;

/** Bayan number issued by ZATCA on successful declaration submission. */
export interface BayanReceipt {
  bayanNo: string;
  /** ISO-8601 UTC. */
  acceptedAt: string;
}
