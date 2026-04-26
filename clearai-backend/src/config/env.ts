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
