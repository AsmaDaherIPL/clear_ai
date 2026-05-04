import { config as dotenvConfig } from 'dotenv';

/**
 * Phase 2.11: scope the dotenv override to development only.
 *
 * Old behaviour: `dotenvConfig({ override: true })` unconditionally overwrote
 * shell exports with .env values. Two problems:
 *   (a) In production (Container Apps) there's no .env, so override is a
 *       no-op — fine, but it's a wasted import-time effect on every cold
 *       start.
 *   (b) An operator who exports a one-off `ANTHROPIC_API_KEY` for `pnpm dev`
 *       gets silently overridden by a stale .env value, with no warning.
 *
 * New behaviour: in production we leave shell-exported vars alone (Container
 * Apps' env-var injection wins); in dev we still load .env but DO NOT
 * override an already-set process.env value. The footgun the original
 * comment cited (a stale ANTHROPIC_API_KEY in zshrc shadowing .env) is
 * less likely than the inverse footgun (a one-off export getting blown
 * away by a stale .env). We pick the latter.
 *
 * We can't read NODE_ENV from a parsed Zod schema before dotenv runs (the
 * schema reads process.env), so we sniff the raw env directly here.
 */
const isProd = process.env.NODE_ENV === 'production';
dotenvConfig({ override: !isProd });

import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().url(),
    /**
     * Phase 2.1: optional separate connection string for migrations. When
     * set, `migrate-and-start.ts` uses this for the migrator pool instead
     * of `DATABASE_URL`. Falls back to DATABASE_URL when unset (the cutover
     * window where 0019_role_separation.sql has run but the env split
     * hasn't propagated yet).
     */
    MIGRATOR_DATABASE_URL: z.string().url().optional(),

    /** ANTHROPIC_BASE_URL is the full Target URI including /v1/messages. */
    ANTHROPIC_API_KEY: z.string().min(1),
    ANTHROPIC_BASE_URL: z.string().url(),
    LLM_MODEL: z.string().min(1).default('claude-haiku-4-5-clearai-dev'),
    LLM_MODEL_STRONG: z.string().min(1).default('claude-sonnet-4-6-clearai-dev'),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

    EMBEDDER_MODEL: z.string().min(1).default('Xenova/multilingual-e5-small'),
    EMBEDDER_DIM: z.coerce.number().int().positive().default(384),

    /** Comma-separated CORS origin allowlist. */
    CORS_ORIGINS: z
      .string()
      .default(
        'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5180,http://localhost:4321',
      )
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter((o) => o.length > 0),
      ),

    /**
     * Shared secret APIM injects via x-apim-shared-secret. Required in
     * production (enforced by the superRefine below — Phase 2.10). Optional
     * in dev/test so `pnpm dev` doesn't have to invent a fake secret.
     */
    APIM_SHARED_SECRET: z.string().min(20).optional(),

    /** Per-IP rate limit (defence-in-depth on top of APIM's policy). */
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  })
  /**
   * Phase 2.10: APIM_SHARED_SECRET is required in production. The previous
   * implementation made it `.optional()` and relied on a runtime branch in
   * server/app.ts to fail-closed when missing. That worked but emitted a
   * single error log per request — easy to miss in a busy Log Analytics
   * stream. With the superRefine, a misconfigured prod deploy fails at
   * boot via Zod's "Environment validation failed" path instead, which
   * surfaces in Container Apps' health UI and immediately keeps the
   * previous revision serving (`migrate-and-start.ts` exits non-zero).
   */
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production' && !v.APIM_SHARED_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APIM_SHARED_SECRET'],
        message:
          'APIM_SHARED_SECRET is required when NODE_ENV=production. Set it via Container Apps secretref to the KV secret `apim-shared-secret`.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;
export function env(): Env {
  if (_env) return _env;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment:\n', parsed.error.flatten().fieldErrors);
    throw new Error('Environment validation failed');
  }
  _env = parsed.data;
  return _env;
}
