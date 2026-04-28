/**
 * Tests for broker-mapping. The lookup queries the live DB, so these tests
 * require docker-compose Postgres to be up and the broker mapping to be
 * ingested (`pnpm db:seed:broker`). They're integration-flavoured but the
 * pool is reused across the suite so the cost is minimal.
 *
 * What we pin here:
 *   - exact-match lookup returns the broker's target
 *   - dotted/spaced inputs are normalised before matching
 *   - prefix walk-up finds shorter keys when the full input isn't present
 *   - genuinely-unknown codes return null (don't fall back to a wrong row)
 *   - minPrefix guard refuses overly short inputs
 */
import { describe, expect, it, afterAll } from 'vitest';
import { lookupBrokerMapping } from './broker-mapping.js';
import { closeDb } from '../db/client.js';

describe('lookupBrokerMapping (live DB)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('returns null for an unknown code', async () => {
    // Use a deliberately-junk 12-digit code very unlikely to exist
    const r = await lookupBrokerMapping('999999999991');
    expect(r).toBeNull();
  });

  it('refuses inputs shorter than minPrefix', async () => {
    const r = await lookupBrokerMapping('123', { minPrefix: 6 });
    expect(r).toBeNull();
  });

  it('finds an exact known mapping (61082100 → 620442000000)', async () => {
    const r = await lookupBrokerMapping('61082100');
    expect(r).not.toBeNull();
    expect(r?.targetCode).toBe('620442000000');
    expect(r?.matchedLength).toBe(8);
  });

  it('normalises dotted input', async () => {
    // 9018.12.0000 is in the source file
    const r = await lookupBrokerMapping('9018.12.0000');
    expect(r).not.toBeNull();
    expect(r?.targetCode).toBe('901812000000');
  });

  it('walks up to a shorter prefix when the full input is not present', async () => {
    // 61082100 is in the table; 6108210099 (made up extension) is not, but
    // the walk-up should find the 8-digit prefix.
    const r = await lookupBrokerMapping('6108210099');
    expect(r).not.toBeNull();
    expect(r?.matchedClientCode).toBe('61082100');
  });
});
