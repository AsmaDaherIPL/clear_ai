/**
 * Env validation tests. We exercise the env() loader with manipulated
 * process.env, verifying the Phase 2.10/2.11 hardening:
 *   - APIM_SHARED_SECRET is REQUIRED when NODE_ENV=production
 *   - APIM_SHARED_SECRET is OPTIONAL when NODE_ENV=development / test
 *   - MIGRATOR_DATABASE_URL is optional and parses as a URL when present
 *
 * The env module caches via a module-level singleton; we re-import via
 * vi.resetModules() between tests to force re-evaluation.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Helper to install / restore process.env for one test.
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  // Fresh module graph each test so the module-level singleton resets.
  vi.resetModules();
});

afterEach(() => {
  process.env = originalEnv;
});

const baseEnv = (): NodeJS.ProcessEnv => ({
  // Minimum required fields.
  DATABASE_URL: 'postgres://user:pass@localhost:5432/clearai?sslmode=require',
  ANTHROPIC_API_KEY: 'sk-test-not-real',
  ANTHROPIC_BASE_URL: 'https://example.com/anthropic/v1/messages',
});

describe('env() — Phase 2.10 superRefine', () => {
  it('rejects production without APIM_SHARED_SECRET', async () => {
    process.env = {
      ...baseEnv(),
      NODE_ENV: 'production',
    };
    const { env } = await import('../../src/config/env.js');
    expect(() => env()).toThrow(/Environment validation failed/);
  });

  it('accepts production with a valid APIM_SHARED_SECRET', async () => {
    process.env = {
      ...baseEnv(),
      NODE_ENV: 'production',
      APIM_SHARED_SECRET: 'a'.repeat(48),
    };
    const { env } = await import('../../src/config/env.js');
    expect(() => env()).not.toThrow();
    const e = env();
    expect(e.APIM_SHARED_SECRET).toBe('a'.repeat(48));
  });

  it('accepts development without APIM_SHARED_SECRET', async () => {
    process.env = {
      ...baseEnv(),
      NODE_ENV: 'development',
    };
    const { env } = await import('../../src/config/env.js');
    expect(() => env()).not.toThrow();
    const e = env();
    expect(e.APIM_SHARED_SECRET).toBeUndefined();
  });

  it('accepts test without APIM_SHARED_SECRET', async () => {
    process.env = {
      ...baseEnv(),
      NODE_ENV: 'test',
    };
    const { env } = await import('../../src/config/env.js');
    expect(() => env()).not.toThrow();
  });

  it('rejects production with a too-short APIM_SHARED_SECRET', async () => {
    process.env = {
      ...baseEnv(),
      NODE_ENV: 'production',
      APIM_SHARED_SECRET: 'short', // < 20 chars
    };
    const { env } = await import('../../src/config/env.js');
    expect(() => env()).toThrow(/Environment validation failed/);
  });
});

describe('env() — MIGRATOR_DATABASE_URL', () => {
  it('parses MIGRATOR_DATABASE_URL when set', async () => {
    process.env = {
      ...baseEnv(),
      NODE_ENV: 'development',
      MIGRATOR_DATABASE_URL: 'postgres://m:p@localhost:5432/clearai',
    };
    const { env } = await import('../../src/config/env.js');
    const e = env();
    expect(e.MIGRATOR_DATABASE_URL).toBe('postgres://m:p@localhost:5432/clearai');
  });

  it('leaves MIGRATOR_DATABASE_URL undefined when unset', async () => {
    process.env = {
      ...baseEnv(),
      NODE_ENV: 'development',
    };
    const { env } = await import('../../src/config/env.js');
    const e = env();
    expect(e.MIGRATOR_DATABASE_URL).toBeUndefined();
  });

  it('rejects a malformed MIGRATOR_DATABASE_URL', async () => {
    process.env = {
      ...baseEnv(),
      NODE_ENV: 'development',
      MIGRATOR_DATABASE_URL: 'not-a-url',
    };
    const { env } = await import('../../src/config/env.js');
    expect(() => env()).toThrow(/Environment validation failed/);
  });
});
