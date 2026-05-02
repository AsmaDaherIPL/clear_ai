/**
 * UUIDv7 generator (RFC 9562).
 *
 * Why UUIDv7 over UUIDv4 (the current PG `gen_random_uuid()` default):
 *   • Time-ordered: the first 48 bits are a Unix-millisecond timestamp,
 *     so generated IDs are roughly monotonic. New rows land at the
 *     "end" of the btree PK index → sequential page writes, no
 *     fragmentation, no random page splits on bulk inserts.
 *   • Same 16-byte width as v4 — zero storage / index-size impact.
 *   • Externally indistinguishable from v4 for clients (still a valid
 *     UUID string).
 *
 * Why generated in TS rather than via PG function:
 *   • Postgres ≥ 18 ships `uuidv7()` natively. We're on 16; the
 *     `pg_uuidv7` extension isn't pre-installed in the docker image.
 *     Generating in TS avoids the Docker-image rebuild + extension
 *     install path while we're still on PG 16/17.
 *   • Bulk inserts (e.g. ingest.ts) already build their own VALUES
 *     payload — supplying ids explicitly fits the existing pattern.
 *
 * Tables that should use this helper:
 *   • hs_codes.id                      (catalog ingest, bulk)
 *   • classification_events.id         (runtime, per-request)
 *   • classification_feedback.id       (runtime, per-feedback)
 *   • Future GUID PKs on hs_code_display / hs_code_search / tenant_code_overrides
 *
 * Tables that may stay on the PG default (`gen_random_uuid()`) for now
 * without harm — append-only, low-write, no sequential-scan concern:
 *   (none — but we tolerate v4 for legacy rows; both are valid UUIDs)
 */
import { uuidv7 } from 'uuidv7';

/** New UUIDv7 string (e.g. "01964b3e-3a92-7c8f-9a2b-1234567890ab"). */
export function newId(): string {
  return uuidv7();
}
