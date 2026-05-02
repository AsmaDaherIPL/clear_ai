/** Fastify entry. Wires plugins, hooks, routes, probes, and graceful shutdown. */
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from '../config/env.js';
import { classifyRoute } from '../routes/classify.js';
import { expandRoute } from '../routes/expand.js';
import { classificationTraceRoute } from '../routes/classification-trace.js';
import { submissionDescriptionRoute } from '../routes/submission-description.js';
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

// CORS allowlist from env. Reflects matched origin (no `*`).
await app.register(cors, {
  origin: e.CORS_ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: false,
  allowedHeaders: ['content-type', 'x-apim-shared-secret', 'ocp-apim-subscription-key'],
});

// In-process per-IP rate limit. Probe paths exempt to keep replicas healthy.
//
// Phase 2.7 hardening: exact-path match (was `startsWith` — that bypassed
// the limiter for any future `/healthz`, `/healthcheck`, `/health-foo`,
// `/ready-debug` route added by mistake). Strip query string defensively
// because `req.url` includes it.
await app.register(rateLimit, {
  max: e.RATE_LIMIT_MAX,
  timeWindow: e.RATE_LIMIT_WINDOW,
  allowList: (req) => isProbePath(req.url),
});

/** Strip query string and match exactly. Phase 2.7. */
function isProbePath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return path === '/health' || path === '/ready';
}

// Origin lock: prod requests must carry the APIM shared secret. Probes exempt;
// dev bypassed; missing secret in prod fails closed with a loud log.
app.addHook('onRequest', async (req, reply) => {
  if (isProbePath(req.url)) return;
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

// Must register BEFORE routes so route throws map to the shared envelope.
registerErrorHandler(app);

/** Liveness probe. 200 while Node is alive and Postgres responds. */
app.get('/health', async () => {
  try {
    const r = await getPool().query<{ ok: number }>(`SELECT 1::int AS ok`);
    return { status: 'ok', db: r.rows[0]?.ok === 1 };
  } catch (err) {
    app.log.error({ err }, 'health PG fail');
    return { status: 'degraded', db: false };
  }
});

/** Readiness probe. 503 until every warmup task resolves; gates traffic routing. */
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

await app.register(classifyRoute);
await app.register(expandRoute);
await app.register(classificationTraceRoute);
await app.register(submissionDescriptionRoute);

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: e.PORT, host: '0.0.0.0' });

    // allSettled (not all) so one non-fatal warmup failure can't stick /ready at 503.
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
        loadPrompt('description-cleanup.md'),
        loadPrompt('chapter-hint.md'),
        loadPrompt('picker-describe.md'),
        loadPrompt('picker-expand.md'),
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
