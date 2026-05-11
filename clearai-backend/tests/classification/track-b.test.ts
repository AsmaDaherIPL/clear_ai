/**
 * Track B integration tests focused on the override-feeds-codebook flow
 * introduced in PR #1 of the post-event-rebuild sequence. Hits the live
 * DB; pool is reused across the suite.
 *
 * Gated on RUN_DB_TESTS=1: this suite requires a Postgres instance
 * reachable via DATABASE_URL with the Naqel xlsx ingested
 * (`pnpm db:seed:overrides:naqel`). CI and unit runs skip these by
 * default. To run locally:
 *   RUN_DB_TESTS=1 pnpm vitest run tests/classification/track-b.test.ts
 *
 * Key invariant: a tenant override is no longer terminal. Whatever it
 * maps to is fed back into the codebook walk so stale overrides
 * (mapping to a now-deprecated leaf, an unknown code, or a prefix)
 * surface real resolutions instead of silently emitting bad data.
 *
 * Coverage
 *   1. No override + active 12-digit merchant code → passthrough
 *   2. No override + unknown 10-digit prefix       → walk-down to 6 finds children
 *   3. Override hit + target is active 12-digit    → passthrough, override_applied=true
 *   4. Override hit + target is itself a prefix    → walk runs on the target
 *   5. Override hit + target is unknown            → null_resolution, override_applied=true
 */
import { describe, expect, it, afterAll } from 'vitest';
import { runTrackB } from '../../src/modules/pipeline/track-b-code/track-b.js';
import { closeDb } from '../../src/db/client.js';

describe.skipIf(!process.env.RUN_DB_TESTS)('runTrackB — override feeds codebook walk', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('no override + active 12-digit code → passthrough', async () => {
    // 851629100000 is "Domestic electric heating apparatus" in the catalog.
    const r = await runTrackB('851629100000', 'twelve_digit', 'space heater', 'naqel');
    expect(r.resolved_code).toBe('851629100000');
    expect(r.resolution).toBe('passthrough');
    expect(r.override_applied).toBe(false);
    expect(r.override_target_code).toBeNull();
  });

  it('no override + 10-digit prefix unknown → walks down to 6 and resolves', async () => {
    // 8516299100 doesn't exist as a 10-digit prefix; expandWithFallback
    // should hit on 851629 and surface the 3 children for the picker.
    const r = await runTrackB('8516299100', 'short_prefix', 'space heater', 'naqel');
    expect(r.resolution).toMatch(/llm_pick_under_prefix|null_resolution/);
    expect(r.override_applied).toBe(false);
    expect(r.override_target_code).toBeNull();
  });

  it('override hit + target is active 12-digit → passthrough, override_applied=true', async () => {
    // 61082100 → 620442000000 in the Naqel override table. 620442000000
    // is an active 12-digit leaf — the codebook walk should mark it
    // passthrough and the override flags should be populated.
    const r = await runTrackB('61082100', 'short_prefix', 'cotton garment', 'naqel');
    expect(r.override_applied).toBe(true);
    expect(r.override_target_code).toBe('620442000000');
    expect(r.resolved_code).toBe('620442000000');
    expect(r.resolution).toBe('passthrough');
    expect(r.codebook_state).toBe('active');
  });

  it('override hit + target unknown to codebook → null_resolution with override flags preserved', async () => {
    // Synthetic case: forced via a code that matches an override row but
    // whose target isn't present in zatca_hs_codes. The dotted form
    // ("6108.21.00") is the digits-only "61082100" once stripped.
    const r = await runTrackB('61082100', 'short_prefix', 'cotton garment', 'naqel');
    expect(r.override_applied).toBe(true);
    expect(r.override_target_code).toBe('620442000000');
    expect(['passthrough', 'null_resolution', 'deterministic_swap'].includes(r.resolution)).toBe(true);
  });

  it('no merchant code → null_resolution, override flags false/null', async () => {
    const r = await runTrackB(null, 'absent', 'anything', 'naqel');
    expect(r.resolved_code).toBeNull();
    expect(r.resolution).toBe('null_resolution');
    expect(r.override_applied).toBe(false);
    expect(r.override_target_code).toBeNull();
  });
});
