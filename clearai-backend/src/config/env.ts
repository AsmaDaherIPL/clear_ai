import { config as dotenvConfig } from 'dotenv';
// Override shell-exported vars so a stale ANTHROPIC_API_KEY in zshrc doesn't shadow .env
dotenvConfig({ override: true });
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  // Foundry: ANTHROPIC_BASE_URL is the FULL Target URI including /v1/messages.
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_BASE_URL: z.string().url(),
  LLM_MODEL: z.string().min(1).default('claude-haiku-4-5-clearai-dev'),
  LLM_MODEL_STRONG: z.string().min(1).default('claude-sonnet-4-6-clearai-dev'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  EMBEDDER_MODEL: z.string().min(1).default('Xenova/multilingual-e5-small'),
  EMBEDDER_DIM: z.coerce.number().int().positive().default(384),

  /**
   * Comma-separated origin allowlist for CORS. Browsers reject `*` when the
   * request carries credentials, and we may add cookie-based auth later, so
   * we keep it explicit. Local dev defaults cover the Astro dev server
   * (:5173) plus the conventional Astro alt port (:4321) for safety.
   * Set to the deployed Cloudflare Pages URL in prod.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:4321')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),

  /**
   * Shared secret that APIM injects on every forwarded request via the
   * `x-apim-shared-secret` header. The Fastify auth hook in server.ts rejects
   * any request to a non-/health route that doesn't carry this exact value.
   *
   * Two reasons it's `.optional()` rather than required:
   *   1. The Container App env var is provisioned out-of-band (Bicep + KV
   *      secretref), and the image must be able to boot for the platform
   *      probe to come up green BEFORE that env var is wired. Treating
   *      this as required would crash-loop the first revision.
   *   2. Local dev shouldn't have to invent a fake APIM secret to run
   *      `pnpm dev` — when the var is unset, the auth hook also does
   *      nothing, so dev keeps working.
   *
   * The hook in server.ts enforces the actual posture: in production we
   * REQUIRE the var by also checking NODE_ENV === 'production', which
   * means a misconfigured prod deploy fails closed (401 on every request)
   * rather than fail open.
   *
   * `.min(20)` so a typo'd 1-char value is still caught at boot.
   */
  APIM_SHARED_SECRET: z.string().min(20).optional(),

  /**
   * Per-IP rate limit for the in-app limiter (defence-in-depth on top of
   * APIM's per-key rate-limit policy). Tuned for v1 traffic — generous for
   * a single-user UI, tight enough to throttle a runaway script.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
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
