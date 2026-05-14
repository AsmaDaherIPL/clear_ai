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

    /**
     * Pipeline architecture selector. Phased migration from the legacy
     * parallel-tracks design (cleanup + researcher + retrieval + picker +
     * codebook walk + 11-rule reconciliation) to the anchored three-stage
     * design (identify -> constrain -> pick).
     *
     * Default 'legacy' until the anchored pipeline is built and shadow-
     * mode validated. The /pipeline/dispatch route also accepts a
     * per-call ?architecture=... query param that overrides this flag
     * for a single classification, used for ad-hoc testing without
     * flipping the global default.
     *
     * Migration plan: PR-A-1 through PR-A-7 (see master table).
     */
    PIPELINE_ARCHITECTURE: z.enum(['legacy', 'anchored']).default('legacy'),

    /**
     * Rolling window size for the transient-rate soft-warn breaker. The
     * last N LLM call outcomes are tracked; transient_rate is the share of
     * those classified as 'transient'. Independent of the hard auth-class
     * breaker — never trips, only warns on /health when sustained.
     */
    LLM_TRANSIENT_RATE_WINDOW: z.coerce.number().int().positive().default(100),

    /**
     * Gate for the pending_infra item status downgrade. Off by default
     * until migration 0077 (which extends declaration_run_items_status_chk)
     * has been applied. With this off, infra-degraded rows fall through
     * to the natural status (succeeded/flagged/failed) — same behaviour
     * as pre-PR 3. Flip to 'true' AFTER the migration runs.
     */
    PENDING_INFRA_ENABLED: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .default('false'),

    /**
     * Gate for the llm_call_metrics fire-and-forget inserts. Off by default
     * until migration 0078 (the table itself) has been applied. With this
     * off, finalize() in inference/llm/client.ts still classifies and
     * counts in-memory (the breaker window) but skips the INSERT.
     */
    LLM_CALL_METRICS_ENABLED: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .default('false'),

    /**
     * Submission-description cache toggle. Off by default — the (path_ar,
     * cleaned_norm) key collapsed too aggressively (two distinct products
     * sharing a chapter/leaf path got the same cached Arabic line). Re-enable
     * once the key includes a per-item attribute fingerprint, or remove
     * the cache layer entirely.
     */
    SUBMISSION_DESCRIPTION_CACHE: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .transform((v) => v === true || v === 'true')
      .default('false'),

    // ── Foundry-hosted embedder (Plan B) ─────────────────────────────────
    /**
     * Foundry resource base or the full embeddings URL. The client appends
     * /openai/deployments/<FOUNDRY_EMBED_MODEL>/embeddings?api-version=…
     * when a plain base URI is supplied.
     */
    FOUNDRY_EMBED_ENDPOINT: z
      .string()
      .url()
      .default('https://aif-infp-dev-swc-01.services.ai.azure.com'),
    FOUNDRY_EMBED_API_KEY: z.string().min(1),
    /** Deployment name on the Foundry resource (NOT the underlying model id). */
    FOUNDRY_EMBED_MODEL: z.string().min(1).default('text-embedding-3-large-clearai-dev'),
    /**
     * Matryoshka truncation. text-embedding-3-large is 3072-dim natively;
     * 1024 keeps the catalog vector(1024) column tractable (~100 MB for
     * 25k rows) and matches MTEB best-practice for multilingual retrieval.
     */
    FOUNDRY_EMBED_DIM: z.coerce.number().int().positive().default(1024),

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

    // ─── BatchPlumber: bulk batch processing ────────────────────────────────

    /** Max concurrent dispatch() calls per batch (in-process p-limit semaphore). */
    BATCH_LLM_CONCURRENCY: z.coerce.number().int().positive().default(8),
    /** Reject uploads larger than this many parsed rows. */
    BATCH_INPUT_MAX_ROWS: z.coerce.number().int().positive().default(1000),
    /** Azure Blob container name for source + result files. */
    BATCH_BLOB_CONTAINER: z.string().min(1).default('batches'),
    /**
     * Adapter selector. Three valid combinations:
     *   - 'file' (default in dev): use BATCH_BLOB_CONNECTION='file://...'
     *     for the local-disk dev fallback.
     *   - 'azure-blob' (prod / dev Azure): set BATCH_BLOB_ACCOUNT to the
     *     storage account short name; auth is via DefaultAzureCredential
     *     (managed identity in Container Apps; az login locally if you
     *     ever run against a public-network-enabled account).
     *   - omitted entirely: backend stays up; the first storage call
     *     throws a clear error, but probes / single-shot pipeline routes
     *     still work.
     */
    BATCH_BLOB_BACKEND: z.enum(['file', 'azure-blob']).optional(),
    /** Storage account short name (e.g. 'stinfpclearaidevgwc01'). Required when BATCH_BLOB_BACKEND='azure-blob'. */
    BATCH_BLOB_ACCOUNT: z.string().min(1).optional(),
    /**
     * Legacy: Azure Blob connection string OR a `file://` URI. Used when
     * BATCH_BLOB_BACKEND is unset (back-compat) or set to 'file'. The
     * MI-auth path (BATCH_BLOB_BACKEND='azure-blob') ignores this entirely
     * — DefaultAzureCredential never sees an account key.
     */
    BATCH_BLOB_CONNECTION: z.string().min(1).optional(),

    // ─── ZATCA Declaration envelope (rendered by BatchPlumber Phase 5) ──────

    // ZATCA submitter credentials moved to per-operator columns on
    // operators in 0062; no env var equivalents.

    // FX rates moved to the fx_rates table in migration 0076. The previous
    // BATCH_FX_RATES_TO_SAR env var fell back to identity (rate=1) on
    // unknown currencies — silent corruption of ZATCA invoice totals.
    // Manual-seed table now hard-rejects unknown currencies at parse time.
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
