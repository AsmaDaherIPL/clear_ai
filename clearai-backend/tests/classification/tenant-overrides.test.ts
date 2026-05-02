/**
 * Tests for tenant-override lookup. The lookup queries the live DB, so these
 * tests require docker-compose Postgres up and the Naqel xlsx ingested
 * (`pnpm db:seed:overrides:naqel`). Integration-flavoured but the pool is
 * reused across the suite so cost is minimal.
 *
 * What we pin:
 *   - exact-match lookup returns the tenant's target
 *   - dotted/spaced inputs are normalised before matching
 *   - prefix walk-up finds shorter keys when the full input isn't present
 *   - genuinely-unknown codes return null (no fall-through to a wrong row)
 *   - minPrefix guard refuses overly short inputs
 *   - tenant scoping: a code only stored under one tenant is invisible
 *     when looked up under another (regression guard for multi-tenant)
 */
import { describe, expect, it, afterAll } from 'vitest';
import { lookupTenantOverride } from '../../src/classification/tenant-overrides.js';
import { closeDb } from '../../src/db/client.js';

describe('lookupTenantOverride (live DB)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('returns null for an unknown code', async () => {
    // Deliberately-junk 12-digit code very unlikely to exist
    const r = await lookupTenantOverride('999999999991', 'naqel');
    expect(r).toBeNull();
  });

  it('refuses inputs shorter than minPrefix', async () => {
    const r = await lookupTenantOverride('123', 'naqel', { minPrefix: 6 });
    expect(r).toBeNull();
  });

  it('finds an exact known mapping (61082100 → 620442000000)', async () => {
    const r = await lookupTenantOverride('61082100', 'naqel');
    expect(r).not.toBeNull();
    expect(r?.targetCode).toBe('620442000000');
    expect(r?.matchedLength).toBe(8);
  });

  it('normalises dotted input', async () => {
    // 9102.19.0000 → 910219000001 in the Naqel source file. Picked because
    // it survives the new "no zero-padding self-map" CHECK constraint
    // (target 910219000001 ≠ rpad("9102190000", 12, '0') = 910219000000).
    const r = await lookupTenantOverride('9102.19.0000', 'naqel');
    expect(r).not.toBeNull();
    expect(r?.targetCode).toBe('910219000001');
  });

  it('walks up to a shorter prefix when the full input is not present', async () => {
    // 61082100 is in the table; 6108210099 is not, but the walk-up
    // should find the 8-digit prefix.
    const r = await lookupTenantOverride('6108210099', 'naqel');
    expect(r).not.toBeNull();
    expect(r?.matchedSourceCode).toBe('61082100');
  });

  it('does not return Naqel rows when looked up under another tenant', async () => {
    // Same code that hits under 'naqel' — must be invisible under 'aramex'
    // because no rows exist for that tenant. This is the regression guard
    // for tenant-scoped lookup.
    const r = await lookupTenantOverride('61082100', 'aramex');
    expect(r).toBeNull();
  });
});
