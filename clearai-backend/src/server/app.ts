/**
 * Fastify v5 entry. Local dev only — production deployment is Phase 2 (Azure).
 */
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from '../config/env.js';
import { describeRoute } from '../routes/describe.js';
import { expandRoute } from '../routes/expand.js';
import { boostRoute } from '../routes/boost.js';
import { traceRoute } from '../routes/trace.js';
import { submissionRoute } from '../routes/submission.js';
import { getPool, closeDb } from '../db/client.js';
import { registerErrorHandler } from './error-handler.js';
import { warmEmbedder } from '../embeddings/embedder.js';
import { loadThresholds } from '../catalog/setup-meta.js';
import { loadPrompt } from '../llm/structured-call.js';

const e = env();

const app = Fastify({
  logger: {
    level: e.LOG_LEVEL,
    ...(e.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', singleLine: true } } }
      : {}),
  },
  bodyLimit: 1 * 1024 * 1024,
});

await app.register(sensible);

// CORS — explicit allowlist from env (CORS_ORIGINS, comma-separated). We
// reflect the matched origin rather than echoing `*`, so future cookie/JWT
// auth doesn't break. Preflight returns 204; the same allowlist gates the
// actual POST that follows.
await app.register(cors, {
  origin: e.CORS_ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  // No credentials yet (no cookie/JWT auth) — flip on when that lands.
  credentials: false,
  // APIM forwards this header on every request; allow it in preflight so
  // the browser doesn't trip on it after the env-var flip lands.
  allowedHeaders: ['content-type', 'x-apim-shared-secret', 'ocp-apim-subscription-key'],
});

// In-process per-IP rate limit — defence-in-depth alongside the APIM
// rate-limit policy. The two layers are intentional: APIM's limit can
// be bypassed by anyone who guesses the Container App FQDN, but the
// shared-secret hook below blocks them at 401 long before this matters.
// This limiter mostly exists to absorb runaway-script bursts from a
// legitimate APIM-fronted client where the per-IP fairness still applies.
await app.register(rateLimit, {
  max: e.RATE_LIMIT_MAX,
  timeWindow: e.RATE_LIMIT_WINDOW,
  // Don't rate-limit probe paths — Container Apps and APIM probes
  // should never get 429'd or the replica gets marked unhealthy and
  // recycled.
  allowList: (req) =>
    req.url.startsWith('/health') || req.url.startsWith('/ready'),
});

// Origin lock — every non-health request must carry the shared secret
// that APIM injects via inbound policy. Direct curls to the Container
// App FQDN (which is publicly hittable on Consumption tier — no VNet)
// fail closed with 401.
//
// Behaviour matrix:
//   NODE_ENV=production + secret unset  → fail closed (401 on everything,
//                                          loud signal that the wire-up
//                                          is broken; better than
//                                          silently allowing all traffic)
//   NODE_ENV=production + secret set    → enforce match
//   NODE_ENV=development                → bypass entirely (local dev
//                                          shouldn't need APIM)
//   /health on any env                  → always allowed (probe path)
app.addHook('onRequest', async (req, reply) => {
  // Both /health (liveness) and /ready (readiness) are probe paths
  // exempt from the APIM gateway lock — Azure probes them directly
  // without going through APIM, so they have no shared secret to
  // present.
  if (req.url.startsWith('/health') || req.url.startsWith('/ready')) return;
  if (e.NODE_ENV !== 'production') return;

  const expected = e.APIM_SHARED_SECRET;
  const provided = req.headers['x-apim-shared-secret'];

  if (!expected) {
    req.log.error('APIM_SHARED_SECRET not set in production — blocking all non-health traffic');
    return reply.code(401).send({
      error: { code: 'origin_access_denied', message: 'gateway not configured' },
    });
  }
  if (provided !== expected) {
    return reply.code(401).send({
      error: { code: 'origin_access_denied', message: 'request did not come through the APIM gateway' },
    });
  }
});

// Global error handler — must be registered BEFORE the routes so any throw
// during route handling (incl. async dependency failures like loadThresholds())
// is mapped to the shared decision envelope rather than a generic 500.
// See src/server/error-handler.ts for the full rationale.
registerErrorHandler(app);

/**
 * Liveness probe. Returns 200 as long as the Node process is alive and
 * Postgres responds. Doesn't check warmup state — Azure should NOT
 * recycle the replica just because the embedder hasn't finished its
 * 1-token warmup pass; the process is fine, we just haven't pre-paid
 * the inference cost yet.
 *
 * Used by:
 *   - Container Apps liveness probe
 *   - APIM smoke tests (anonymous /health proxy)
 *   - Manual operator checks
 */
app.get('/health', async () => {
  try {
    const r = await getPool().query<{ ok: number }>(`SELECT 1::int AS ok`);
    return { status: 'ok', db: r.rows[0]?.ok === 1 };
  } catch (err) {
    app.log.error({ err }, 'health PG fail');
    return { status: 'degraded', db: false };
  }
});

/**
 * Readiness probe — flipped TRUE only after every cold-start warmup
 * task resolves (embedder weights loaded + 1-token forward pass run,
 * setup_meta cache primed, hot prompts pre-read).
 *
 * Why this exists separately from /health:
 *   Container Apps' readiness probe gates *traffic routing*, not
 *   replica lifecycle. While /ready returns 503, Azure withholds the
 *   new revision from active rotation — the previous revision keeps
 *   serving until the new one signals ready. That eliminates the
 *   "first request after deploy hits a cold replica" tail (~10-15s
 *   measured on 'men white shirt' classify).
 *
 *   /health (liveness) MUST keep returning 200 the whole time, or
 *   Azure will conclude the replica is broken and recycle it before
 *   warmup ever completes.
 *
 * The probe failureThreshold (3 × periodSeconds=10) gives ~30s for
 * warmup, which comfortably covers our worst-case ONNX cold init
 * (~10-15s) plus headroom.
 */
let isWarm = false;
app.get('/ready', async (_req, reply) => {
  if (!isWarm) {
    return reply
      .code(503)
      .header('retry-after', '5')
      .send({ status: 'warming', detail: 'in-process caches still cold' });
  }
  return { status: 'ready' };
});

await app.register(describeRoute);
await app.register(expandRoute);
await app.register(boostRoute);
await app.register(traceRoute);
await app.register(submissionRoute);

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: e.PORT, host: '0.0.0.0' });

    // Warmup. Listener is already up so /health returns 200 (process
    // is alive); /ready stays 503 until every warmup task settles, so
    // Container Apps holds traffic on the previous revision until this
    // one is genuinely hot.
    //
    // Cold-start cost without warmup, measured on "men white shirt":
    //   - ONNX embedder weights + graph compile  ~5-10s
    //   - setup_meta SELECT round-trip            ~50-200ms
    //   - 6 prompt-file lazy reads                ~200ms total
    //
    // We use Promise.allSettled (not all) so a non-fatal warmup
    // failure (e.g. one prompt file missing) doesn't permanently stick
    // /ready at 503. The errors get logged at warn; the rest of the
    // pipeline still works lazily on first request.
    Promise.allSettled([
      warmEmbedder().then(
        () => app.log.info('embedder warmed'),
        (err: unknown) => app.log.warn({ err }, 'embedder warmup failed (non-fatal)'),
      ),
      loadThresholds().then(
        () => app.log.info('setup_meta cache primed'),
        (err: unknown) => app.log.warn({ err }, 'setup_meta warmup failed (non-fatal)'),
      ),
      Promise.all([
        loadPrompt('merchant-cleanup.md'),
        loadPrompt('picker-describe.md'),
        loadPrompt('gir-system.md'),
        loadPrompt('branch-rank.md'),
        loadPrompt('submission-description.md'),
        loadPrompt('best-effort-heading.md'),
      ]).then(
        () => app.log.info('prompt cache primed'),
        (err: unknown) => app.log.warn({ err }, 'prompt warmup failed (non-fatal)'),
      ),
    ]).then(() => {
      isWarm = true;
      app.log.info('readiness probe now passing — instance ready for traffic');
    });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown error');
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();
