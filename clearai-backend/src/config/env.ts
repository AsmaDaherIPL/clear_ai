import { config as dotenvConfig } from 'dotenv';
// Override shell vars so a stale ANTHROPIC_API_KEY in zshrc doesn't shadow .env.
dotenvConfig({ override: true });
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

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

  /** Shared secret APIM injects via x-apim-shared-secret. Required in production via the auth hook. */
  APIM_SHARED_SECRET: z.string().min(20).optional(),

  /** Per-IP rate limit (defence-in-depth on top of APIM's policy). */
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
