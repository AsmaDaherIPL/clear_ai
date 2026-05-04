/**
 * ClearAI BFF — same-origin proxy from the Astro SPA to the APIM gateway.
 *
 *
 *   Browser ──/api/classifications/*──▶ this Function ──Authorization: Bearer──▶ APIM
 *
 * The browser bundle ships ZERO credentials. This Function (running in the
 * SWA managed-functions sidecar) holds the Entra client_secret server-side,
 * exchanges it for an access token via client-credentials grant, and forwards
 * the SPA's request unchanged otherwise.
 *

 */
import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { ClientSecretCredential, DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

// -------------------------------------------------------------------------
// Configuration (all from environment — see local.settings.json.example)
// -------------------------------------------------------------------------

interface BffConfig {
  apimBaseUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  apiScope: string;
  maxRequestBytes: number;
  forwardSubKey: boolean;
  /** Only used when forwardSubKey === true. */
  apimSubscriptionKey: string | null;
}

let _config: BffConfig | null = null;
let _credential: ClientSecretCredential | null = null;

/**
 * Resolve the Entra app's client_secret. Production path: fetch from
 * Key Vault at runtime via the SWA's system-assigned managed identity
 * (DefaultAzureCredential picks up the SWA MI in the Functions
 * sidecar). Local-dev path: read literal ENTRA_CLIENT_SECRET from env
 * — this branch is only ever taken when the env var is set, which
 * MUST NOT happen in any deployed environment (verified via the
 * directive's defence-in-depth check that the App Setting is absent).
 *
 * The KV path uses the bare secret name (default: bff-client-secret),
 * pinned by the ENTRA_CLIENT_SECRET_KV_NAME + ENTRA_CLIENT_SECRET_KV_SECRET
 * App Settings. The SWA MI must hold 'Key Vault Secrets User' on the
 * KV resource scope for this to work; if that role is missing the
 * caller will see HTTP 500 + bff_misconfigured (NOT the secret
 * itself, NOT the credential object — see ctx.error usage in handle).
 */
async function resolveClientSecret(): Promise<string> {
  const literal = process.env.ENTRA_CLIENT_SECRET;
  if (literal && literal.length > 0) {
    // Local-dev escape hatch only. Production paths set ENTRA_CLIENT_SECRET_KV_NAME
    // and leave ENTRA_CLIENT_SECRET unset so the secret never appears in App Settings.
    return literal;
  }

  const kvName = process.env.ENTRA_CLIENT_SECRET_KV_NAME;
  const secretName = process.env.ENTRA_CLIENT_SECRET_KV_SECRET ?? 'bff-client-secret';
  if (!kvName || kvName.length === 0) {
    throw new Error(
      'BFF client_secret unavailable: set ENTRA_CLIENT_SECRET_KV_NAME (preferred) ' +
        'or ENTRA_CLIENT_SECRET (literal, dev-only).',
    );
  }

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(`https://${kvName}.vault.azure.net`, credential);
  const result = await client.getSecret(secretName);
  if (!result.value || result.value.length === 0) {
    throw new Error(`Key Vault secret ${kvName}/${secretName} is empty or unreadable.`);
  }
  return result.value;
}

async function loadConfig(): Promise<BffConfig> {
  if (_config) return _config;
  const need = (key: string): string => {
    const v = process.env[key];
    if (!v || v.length === 0) {
      throw new Error(`Missing required env: ${key}`);
    }
    return v;
  };
  const optional = (key: string): string | null => {
    const v = process.env[key];
    return v && v.length > 0 ? v : null;
  };
  const forwardSubKey =
    (process.env.BFF_FORWARD_SUB_KEY ?? 'false').toLowerCase() === 'true';
  _config = {
    apimBaseUrl: need('APIM_BASE_URL').replace(/\/+$/, ''),
    tenantId: need('ENTRA_TENANT_ID'),
    clientId: need('ENTRA_CLIENT_ID'),
    clientSecret: await resolveClientSecret(),
    apiScope: need('ENTRA_API_SCOPE'),
    maxRequestBytes: Number.parseInt(
      process.env.BFF_MAX_REQUEST_BYTES ?? '262144',
      10,
    ),
    forwardSubKey,
    apimSubscriptionKey: forwardSubKey ? optional('APIM_SUBSCRIPTION_KEY') : null,
  };
  return _config;
}

function getCredential(cfg: BffConfig): ClientSecretCredential {
  if (_credential) return _credential;
  _credential = new ClientSecretCredential(
    cfg.tenantId,
    cfg.clientId,
    cfg.clientSecret,
  );
  return _credential;
}

// -------------------------------------------------------------------------
// Path allow-list — defence-in-depth so a future router-mistake doesn't
// expose a new APIM operation through this proxy without explicit review.
//
// Add entries here when a new APIM operation lands. Anything else returns
// 404 (we don't even forward to APIM).
// -------------------------------------------------------------------------

interface AllowEntry {
  method: 'GET' | 'POST';
  /** Pattern relative to APIM base. {id} = UUID matcher; everything else literal. */
  pattern: RegExp;
}

const ALLOW: AllowEntry[] = [
  // Probe — anonymous on APIM side, but we still want it allow-listed so
  // we can return 404 on `/api/health-foo` etc. instead of forwarding.
  { method: 'GET', pattern: /^\/health$/ },

  // Classifications API surface (matches src/lib/api.ts on the frontend).
  { method: 'POST', pattern: /^\/classifications$/ },
  { method: 'POST', pattern: /^\/classifications\/expand$/ },
  {
    method: 'GET',
    pattern: /^\/classifications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  },
  {
    method: 'POST',
    pattern: /^\/classifications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/feedback$/,
  },
  {
    method: 'POST',
    pattern: /^\/classifications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/submission-description$/,
  },
];

function isAllowed(method: string, path: string): boolean {
  return ALLOW.some(
    (a) => a.method === method.toUpperCase() && a.pattern.test(path),
  );
}

// -------------------------------------------------------------------------
// Handler
// -------------------------------------------------------------------------

/**
 * Strip the leading `/api` from the SWA-prefixed route. SWA routes
 * /api/<funcname>/* through this Function; the Function's `route` template
 * captures the rest under `path`.
 */
function backendPathOf(req: HttpRequest, ctx: InvocationContext): string {
  // Functions v4 binding name: `path` (matches the {*path} segment in
  // function definition below). Defensive fallback: parse req.url.
  const tail = ctx.triggerMetadata?.path;
  if (typeof tail === 'string' && tail.length > 0) {
    return `/${tail}`;
  }
  // Fallback: derive from req.url
  const u = new URL(req.url);
  return u.pathname.replace(/^\/api/, '') || '/';
}

async function readBodyBounded(
  req: HttpRequest,
  maxBytes: number,
): Promise<string | null> {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    return Symbol.for('too-large') as unknown as string;
  }
  if (buf.byteLength === 0) return null;
  return Buffer.from(buf).toString('utf8');
}

async function handle(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  let cfg: BffConfig;
  try {
    cfg = await loadConfig();
  } catch (err) {
    // TEMPORARY DIAGNOSTIC — one-shot carve-out from §8 logging
    // restrictions, authorised by user for MI/KV credential-chain
    // diagnosis. Logs the exception identity + which env vars the
    // sidecar actually sees. Does NOT log: secret value, access
    // token, or KV secret content. Revert immediately after capture.
    ctx.error('BFF config missing', {
      errorMessage: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : 'unknown',
      hasIdentityEndpoint: !!process.env.IDENTITY_ENDPOINT,
      hasIdentityHeader: !!process.env.IDENTITY_HEADER,
      hasMsiEndpoint: !!process.env.MSI_ENDPOINT,
      hasKvName: !!process.env.ENTRA_CLIENT_SECRET_KV_NAME,
      hasKvSecret: !!process.env.ENTRA_CLIENT_SECRET_KV_SECRET,
      hasLiteralSecret: !!process.env.ENTRA_CLIENT_SECRET,
      kvNameValue: process.env.ENTRA_CLIENT_SECRET_KV_NAME,
    });
    return { status: 500, jsonBody: { error: 'bff_misconfigured' } };
  }

  const backendPath = backendPathOf(req, ctx);

  if (!isAllowed(req.method, backendPath)) {
    ctx.warn('rejected non-allowlisted path', {
      method: req.method,
      path: backendPath,
    });
    return { status: 404, jsonBody: { error: 'not_found' } };
  }

  // Body bound check.
  const body = await readBodyBounded(req, cfg.maxRequestBytes);
  if (body === (Symbol.for('too-large') as unknown as string)) {
    return { status: 413, jsonBody: { error: 'payload_too_large' } };
  }

  // Token fetch (cached by ClientSecretCredential).
  let token: string;
  try {
    const credential = getCredential(cfg);
    const tokenResult = await credential.getToken(cfg.apiScope);
    if (!tokenResult || !tokenResult.token) {
      throw new Error('empty token result');
    }
    token = tokenResult.token;
  } catch (err) {
    ctx.error('Entra token fetch failed', err);
    return { status: 502, jsonBody: { error: 'upstream_auth_failed' } };
  }

  // Build the upstream request.
  const upstreamUrl = `${cfg.apimBaseUrl}${backendPath}`;
  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body) {
    upstreamHeaders['Content-Type'] = 'application/json';
  }
  if (cfg.forwardSubKey && cfg.apimSubscriptionKey) {
    upstreamHeaders['Ocp-Apim-Subscription-Key'] = cfg.apimSubscriptionKey;
  }

  // Forward the language hint if the SPA sent one — useful for the
  // backend's lang-detect override path. Not auth-relevant.
  const acceptLanguage = req.headers.get('accept-language');
  if (acceptLanguage) {
    upstreamHeaders['Accept-Language'] = acceptLanguage;
  }

  // Hard upstream timeout — APIM caps at 30s end-to-end on Consumption,
  // but we want a tighter lid in the BFF so a stuck upstream doesn't tie
  // up Function compute (cost) or the browser's UX (no progress signal).
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 25_000);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: body ?? undefined,
      signal: ac.signal,
    });

    const upstreamBody = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('content-type') ?? 'application/json';

    // Pass through 4xx unchanged so SPA can render Zod-validation errors
    // (`{error: 'invalid_body', detail: {...}}`) and 404 (`not_found`).
    // Map 5xx to a generic 503 so we don't leak APIM internals to the
    // browser. Keep the body small.
    const status = upstream.status;
    if (status >= 500) {
      ctx.warn('upstream 5xx', { status, path: backendPath });
      return {
        status: 503,
        jsonBody: { error: 'upstream_unavailable' },
      };
    }

    return {
      status,
      headers: { 'Content-Type': contentType },
      body: Buffer.from(upstreamBody),
    };
  } catch (err: unknown) {
    const isAbort =
      err instanceof Error && /aborted|abort/i.test(err.message);
    if (isAbort) {
      ctx.warn('upstream timeout', { path: backendPath });
      return { status: 504, jsonBody: { error: 'upstream_timeout' } };
    }
    ctx.error('proxy fetch failed', err);
    return { status: 502, jsonBody: { error: 'upstream_unreachable' } };
  } finally {
    clearTimeout(timeout);
  }
}

// -------------------------------------------------------------------------
// Function definitions — one per HTTP verb. SWA routes /api/<name>/* via
// the route template; the wildcard segment {*path} captures the rest.
//
// Naming: a single function name "clearai" so the SPA URL is /api/clearai/...
// would be ugly. Instead we mount the route at the bare `{*path}` so the
// SPA can keep calling /api/classifications, /api/classifications/expand
// etc. without an extra path segment. SWA managed-functions support this
// pattern.
// -------------------------------------------------------------------------

app.http('clearaiProxyGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: '{*path}',
  handler: handle,
});

app.http('clearaiProxyPost', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: '{*path}',
  handler: handle,
});
