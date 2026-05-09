// =============================================================================
// API Management (Consumption tier) — ClearAI dev gateway
// =============================================================================
// - SKU: Consumption (capacity 0). No VNet, no custom domain.
// - System-assigned managed identity (used to read the shared secret from KV).
// - One API: `clearai-backend` (path '', subscriptionRequired: false)
//   Operations are imported from clearai-backend/openapi.yaml — that file is
//   the single source of truth for the HTTP surface. Re-running this Bicep
//   re-imports the spec; APIM matches operations by auto-generated
//   operationId (`{method}-{normalized-path}`) and updates them in place.
//   New paths added to the YAML appear automatically; deleted paths are
//   removed automatically. Per-operation policies declared below survive
//   re-import as long as the operationId stays stable.
//
//   Imported operations (gateway URLs):
//     GET   https://{apim}.azure-api.net/health                                    (anonymous, short-circuited)
//     GET   https://{apim}.azure-api.net/ready                                     (validate-jwt)
//     POST  https://{apim}.azure-api.net/declaration-runs                          (validate-jwt)
//     GET   https://{apim}.azure-api.net/declaration-runs/{id}                     (validate-jwt)
//     PATCH https://{apim}.azure-api.net/declaration-runs/{id}                     (validate-jwt)
//     GET   https://{apim}.azure-api.net/declaration-runs/{id}/classifications     (validate-jwt)
//     POST  https://{apim}.azure-api.net/pipeline/submission-description           (validate-jwt)
//
//   The previous /classifications/* endpoints were retired in backend commit
//   107b87c (legacy single-path classifier deleted; replaced by the two-track
//   pipeline under /declaration-runs/*). The OpenAPI re-import drops them
//   from APIM automatically — no manual cleanup needed.
//
//   The previous separate `clearai-backend-public` API at path 'health'
//   was collapsed into the imported `/health` operation. A per-operation
//   policy override on `/health` reproduces the canned `{"status":"ok"}`
//   short-circuit (no validate-jwt, no backend hop) so the anonymous probe
//   keeps the same security posture as before (no DB-state leakage — see
//   I1 from the frontend security review).
//
// - Inbound API policy (applied to BOTH APIs):
//     a) CORS — allow the SWA frontend, the APIM gateway itself (server-to-
//        server tests), and the two Astro/Vite dev ports for local browser
//        sessions. credentials disabled (we use header-based auth, not
//        cookies). preflight cache 10 min. Allowed methods GET/POST/OPTIONS
//        only; allowed headers content-type + Ocp-Apim-Subscription-Key.
//        When a custom domain is added (separate task) it must be appended
//        to this list AND to the Container App CORS_ORIGINS env var.
//     b) Strip any client-supplied x-apim-shared-secret header (anti-spoof)
//     c) Re-inject x-apim-shared-secret from a named-value
//     d) Rate limit per subscription, 60 req/min  (rate-limit-by-key isn't
//        supported on Consumption SKU, so we use the simpler rate-limit
//        policy. /health is anonymous and unaffected — Fastify's in-process
//        limiter covers that path.)
//
// - Named value `apim-shared-secret`:
//   The bicep creates it with a *placeholder* inline value. deploy.sh flips
//   it to KV-backed AFTER granting APIM's MI 'Key Vault Secrets User'.
//   Reason: the keyVault binding gets validated at named-value create time,
//   but APIM's MI doesn't exist until APIM itself is created — so the role
//   assignment can't happen before this bicep deploy. Decoupling the value
//   from the bicep avoids that chicken-and-egg.
//
// - Product `clearai`:
//   Custom product (not the built-in `unlimited`/`starter`) so subscription
//   keys minted here are explicitly scoped to ClearAI APIs. Built-in product
//   names aren't guaranteed across SKUs/regions on Consumption tier and
//   referencing them by Bicep dies with `Product not found`.
//
// - Constraints (Consumption tier):
//     * Max request body 256 KB. ClearAI bodies are <2 KB so this is fine.
//     * Provisioning takes 10–30 minutes on first create.
//     * No VNet integration. The shared-secret header IS the origin lock.
//     * Some `customProperties` (TLS toggles) are unsupported on Consumption.
// =============================================================================

@description('Region.')
param location string

@description('APIM service name. Must be globally unique.')
param apimName string

@description('Publisher display name (shown on the developer portal).')
param publisherName string = 'ClearAI'

@description('Publisher email.')
param publisherEmail string

@description('Backend Container App ingress URL (https://...azurecontainerapps.io).')
param backendUrl string

@description('Log Analytics workspace resource ID. Diagnostic settings forward GatewayLogs and GatewayMetrics here.')
param logAnalyticsWorkspaceId string

@description('Entra tenant id (GUID). Workforce tenant that issues JWTs accepted by validate-jwt.')
param entraTenantId string

@description('Application ID URI of the protected API app registration (infp-clearai-api-dev-01). Primary accepted audience.')
param entraApiAppIdUri string

@description('Optional client_id GUID of the protected API app. Accepted as alternate audience alongside entraApiAppIdUri.')
param entraApiClientId string = ''

@description('Key Vault name that holds the apim-shared-secret. The named value is bound directly to this KV secret via the APIM system MI.')
param keyVaultName string = 'kv-infp-clearai-dev-gwc'

@description('Set to true ONLY on the very first APIM deploy in a fresh subscription, before the APIM MI has been granted Key Vault Secrets User on the KV. When true, the named value is created with an inline placeholder value; deploy.sh then grants the role and re-runs bicep with this flag set false. Subsequent deploys leave it false (default) so the named value stays KV-backed and is NOT overwritten on every apply.')
param namedValueBootstrap bool = false

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------
// Derived
// -----------------------------------------------------------------------------

// The inbound policy — same XML on both APIs.
//
// Auth model (post-Option-A cutover, see docs/SECURITY-REMEDIATION-PLAN.md §1):
//
//   1. `validate-jwt` is the SOLE auth gate. APIM validates Entra-issued
//      bearer tokens against the Workforce tenant's OIDC config, requires
//      the audience to match `api://infp-clearai-api-dev-01` (or the
//      app's client_id GUID as alternate audience), and rejects everything
//      else with HTTP 401.
//
//   2. `subscriptionRequired: false` on the API resource (see below) —
//      the previous architecture's APIM subscription key is gone. JWTs
//      come from a confidential client (the SWA BFF Function), never
//      from the browser bundle. C1 / H1 fixed.
//
//   3. The `x-apim-shared-secret` header is still set (defence-in-depth
//      against direct CA-FQDN bypass) but is no longer the primary auth.
//      The Fastify hook on the Container App still requires it; APIM
//      injects it from the KV-backed named-value. Anti-spoof:
//      exists-action="delete" on the inbound replaces any client-supplied
//      value before re-setting from the named-value.
//
//   4. CORS still origin-locks to the SWA hostnames (custom domain +
//      auto-hostname) for browser preflights. allowed-headers no longer
//      includes `ocp-apim-subscription-key` (the BFF doesn't send it
//      from the browser; it's a server-side concern only) and DOES
//      include `authorization` for the Bearer token preflight.
//
//   5. `rate-limit calls="60" renewal-period="60"` is per-subscription on
//      the Consumption SKU (rate-limit-by-key isn't available). Without
//      a subscription requirement this becomes a per-API-instance global
//      cap instead of per-tenant — coarser but still useful as a runaway
//      script absorber. Per-user rate limiting moves to the BFF Function
//      (in-process per-IP) and to the in-app Fastify rate-limit.
//
// CORS allow-list. Browser-side callers are the SWA (auto-hostname and
// custom domain); the gateway origin is included so server-to-server
// smoke tests work; localhost ports for Astro/Vite local dev. Keep in
// sync with `CORS_ORIGINS` in containerapp.bicep.
var corsAllowedOrigins = [
  'https://apim-infp-clearai-be-dev-gwc-01.azure-api.net'
  'http://localhost:5173'
  'http://localhost:4321'
  'http://localhost:5180'
  // SWA auto-hostname (kept while the custom domain bedds in; can be
  // dropped later if all clients move to the custom domain).
  'https://yellow-glacier-05e43ee03.7.azurestaticapps.net'
  // Custom domain attached to the SWA (DNS + cert managed by Azure).
  'https://clearai-dev.infinitepl.app'
]

// Render the <origin> children. `map` + `join` produces the repeated XML
// elements; we concat into the policy XML below using regular Bicep string
// interpolation. Multi-line ('''...''') strings don't do interpolation, so
// the policy is built as one regular interpolated string.
var corsOriginXml = join(map(corsAllowedOrigins, o => '      <origin>${o}</origin>'), '\n')

// Optional alternate audience (the app's client_id GUID). When the user
// hasn't filled `entraApiClientId` yet, we still emit a single audience
// (the AppId URI) — empty audience strings would fail validation.
var altAudienceXml = empty(entraApiClientId) ? '' : '      <audience>${entraApiClientId}</audience>\n'

// OIDC discovery URL. Workforce tenant uses the v2.0 endpoint; the issuer
// claim it emits is `https://login.microsoftonline.com/{tenant-id}/v2.0`
// and that's what we whitelist. (External ID / CIAM tenants would use
// `{tenant-id}.ciamlogin.com` — not what we have here.)
var entraOidcUrl = 'https://login.microsoftonline.com/${entraTenantId}/v2.0/.well-known/openid-configuration'
var entraIssuer  = 'https://login.microsoftonline.com/${entraTenantId}/v2.0'

// API-level inbound policy. Applies to every imported operation EXCEPT
// /health, which has a per-operation policy override below.
//
// PATCH was added to allowed-methods on 2026-05-06 alongside the OpenAPI
// import refactor — `PATCH /declaration-runs/{id}` (cancel run) is a new
// method introduced by the two-track pipeline. Without it browser
// preflights for the cancel button would fail.
var apiInboundPolicyXml = '<policies>\n  <inbound>\n    <base />\n    <cors allow-credentials="false">\n      <allowed-origins>\n${corsOriginXml}\n      </allowed-origins>\n      <allowed-methods preflight-result-max-age="600">\n        <method>GET</method>\n        <method>POST</method>\n        <method>PATCH</method>\n        <method>OPTIONS</method>\n      </allowed-methods>\n      <allowed-headers>\n        <header>content-type</header>\n        <header>authorization</header>\n        <header>accept-language</header>\n      </allowed-headers>\n    </cors>\n    <validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized — bearer token missing or invalid" require-scheme="Bearer" require-signed-tokens="true" require-expiration-time="true">\n      <openid-config url="${entraOidcUrl}" />\n      <audiences>\n        <audience>${entraApiAppIdUri}</audience>\n${altAudienceXml}      </audiences>\n      <issuers>\n        <issuer>${entraIssuer}</issuer>\n      </issuers>\n    </validate-jwt>\n    <set-header name="x-apim-shared-secret" exists-action="delete" />\n    <set-header name="x-apim-shared-secret" exists-action="override">\n      <value>{{apim-shared-secret}}</value>\n    </set-header>\n    <rate-limit calls="60" renewal-period="60" />\n  </inbound>\n  <backend>\n    <base />\n  </backend>\n  <outbound>\n    <base />\n  </outbound>\n  <on-error>\n    <base />\n  </on-error>\n</policies>'

// Per-operation override for the imported `/health` operation (operationId
// `get-health` after APIM auto-normalisation of GET /health). Reproduces
// the previous separate-public-API behaviour: no validate-jwt, no rate-limit,
// short-circuits with canned {"status":"ok"} so the request never reaches
// the backend. Strips any client-supplied x-apim-shared-secret (anti-spoof)
// before APIM would inject it — irrelevant for the canned response, but
// kept uniform with the protected policy chain.
//
// Why the canned response and not a real backend probe: the OpenAPI
// schema for /health includes a `db: boolean` field that the backend
// returns based on Postgres connectivity. We deliberately do NOT forward
// the call so that the anonymous probe cannot disclose DB-up state to
// scanners (frontend security review I1).
var healthOperationPolicyXml = '<policies>\n  <inbound>\n    <cors allow-credentials="false">\n      <allowed-origins>\n${corsOriginXml}\n      </allowed-origins>\n      <allowed-methods preflight-result-max-age="600">\n        <method>GET</method>\n      </allowed-methods>\n      <allowed-headers>\n        <header>content-type</header>\n      </allowed-headers>\n    </cors>\n    <set-header name="x-apim-shared-secret" exists-action="delete" />\n    <return-response>\n      <set-status code="200" reason="OK" />\n      <set-header name="Content-Type" exists-action="override">\n        <value>application/json</value>\n      </set-header>\n      <set-body>{"status":"ok"}</set-body>\n    </return-response>\n  </inbound>\n  <backend>\n    <base />\n  </backend>\n  <outbound>\n    <base />\n  </outbound>\n  <on-error>\n    <base />\n  </on-error>\n</policies>'

// -----------------------------------------------------------------------------
// APIM service (Consumption)
// -----------------------------------------------------------------------------

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: apimName
  location: location
  tags: tags
  sku: {
    name: 'Consumption'
    capacity: 0
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherName: publisherName
    publisherEmail: publisherEmail
    publicNetworkAccess: 'Enabled'
    virtualNetworkType: 'None'
    disableGateway: false
  }
}

// -----------------------------------------------------------------------------
// Named value — KV-backed by default, bootstrap-only on first deploy.
// -----------------------------------------------------------------------------
// Two modes:
//
//   1. Bootstrap mode (`namedValueBootstrap = true`, ONE-TIME):
//      Used on the very first APIM deploy in a fresh subscription, before
//      the APIM system MI has been granted `Key Vault Secrets User` on the
//      KV. Bicep would fail with `Caller is not authorized` if it tried to
//      bind to the KV reference at this point, so we set an inline
//      placeholder. deploy.sh then:
//        a) reads APIM's MI principalId
//        b) grants Key Vault Secrets User on the KV
//        c) re-runs bicep with `namedValueBootstrap = false`
//      After that, mode 2 takes over and the named value is permanent.
//
//   2. KV-backed mode (`namedValueBootstrap = false`, DEFAULT):
//      Named value is bound to the KV secret via the APIM MI. Bicep applies
//      are idempotent — re-running bicep with the same params leaves the
//      named value unchanged. KV-secret rotation propagates within ~4h
//      auto-refresh or instantly via `az rest POST .../refreshSecret`.
//
// CRITICAL: do NOT regress this back to "always set inline value". A
// previous version of this file did that, which silently overwrote the
// KV-backed binding on every bicep apply, leaving APIM injecting a literal
// placeholder string as the shared-secret header → backend rejected every
// SPA call with `origin_access_denied` 401.

resource sharedSecretNamedValue 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'apim-shared-secret'
  properties: namedValueBootstrap ? {
    displayName: 'apim-shared-secret'
    secret: true
    value: '__bootstrap_replaced_by_deploy_sh__'
  } : {
    displayName: 'apim-shared-secret'
    secret: true
    keyVault: {
      secretIdentifier: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/apim-shared-secret'
    }
  }
}

// -----------------------------------------------------------------------------
// API — clearai-backend (protected, OpenAPI-imported)
// -----------------------------------------------------------------------------
// Operations are defined in clearai-backend/openapi.yaml. APIM imports the
// spec at deploy time and creates one operation per path. Re-deployment
// re-imports — operations matched by operationId update in place; new ones
// are added; deleted ones are removed.
//
// Auto-generated operationIds (because the YAML doesn't specify them):
//   GET   /health                                     -> get-health
//   GET   /ready                                      -> get-ready
//   POST  /declaration-runs                           -> post-declaration-runs
//   GET   /declaration-runs/{id}                      -> get-declaration-runs-id
//   PATCH /declaration-runs/{id}                      -> patch-declaration-runs-id
//   GET   /declaration-runs/{id}/classifications      -> get-declaration-runs-id-classifications
//   POST  /pipeline/submission-description            -> post-pipeline-submission-description
//
// Recommendation for the backend agent: explicitly set operationId on each
// path in openapi.yaml to insulate against APIM auto-naming. Without
// explicit IDs, any future rename of a path segment would generate a new
// operationId and orphan per-operation policies (notably the /health
// override below). With explicit IDs, the policy resource name stays stable.

resource apiProtected 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'clearai-backend'
  properties: {
    displayName: 'ClearAI Backend'
    description: 'ClearAI backend operations. Most require Entra-issued bearer token (validate-jwt policy at API level); /health is anonymously short-circuited by per-operation policy. Source of truth for the operation list is clearai-backend/openapi.yaml.'
    path: ''   // mounted at root
    protocols: [ 'https' ]
    serviceUrl: backendUrl
    // No APIM subscription key — JWT is the sole auth gate at API level.
    // Per-operation overrides may relax this for specific routes (today:
    // only /health). Multiple frontends (the SPA, mobile/partner clients
    // in future) each register as their own client in the same tenant;
    // APIM trusts JWTs whose audience matches the API app registration
    // regardless of which client issued them.
    subscriptionRequired: false
    apiType: 'http'
    type: 'http'
    // Import the OpenAPI spec inline. loadTextContent reads the YAML at
    // Bicep compile time and embeds it as a string in the deployment.
    // The 4 MB inline-import limit is comfortably above our ~20 KB spec.
    // Path is relative to this Bicep file (clearai-backend/infra/modules/apim.bicep);
    // openapi.yaml is at clearai-backend/openapi.yaml -> '../../openapi.yaml'.
    format: 'openapi'
    value: loadTextContent('../../openapi.yaml')
  }
}

resource apiProtectedPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: apiProtected
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: apiInboundPolicyXml
  }
  dependsOn: [
    sharedSecretNamedValue
  ]
}

// -----------------------------------------------------------------------------
// Per-operation policy override: GET /health (anonymous short-circuit)
// -----------------------------------------------------------------------------
// The API-level inbound policy applies validate-jwt + shared-secret +
// rate-limit to every operation by default. /health needs to be anonymous
// (no bearer token, used by uptime monitors, BFF probes, k8s-style probes
// in future), AND its response should NOT disclose internal DB-state
// (frontend security review I1). This per-operation policy overrides the
// API-level chain for /health alone:
//   - Skips <base /> -> does NOT inherit validate-jwt or rate-limit
//   - CORS still applied (browser anonymous probes from allowed origins)
//   - Strips any client-supplied x-apim-shared-secret (anti-spoof)
//   - <return-response> short-circuits with canned {"status":"ok"}
//     before any backend hop happens
//
// IMPORTANT: the resource name `<api>/<operationId>/policy` references
// the auto-generated operationId `get-health`. If the backend agent
// later adds an explicit operationId on /health in openapi.yaml, update
// this name to match. Without a match this resource fails to deploy
// with `OperationNotFound`.

resource opHealthPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  name: '${apim.name}/${apiProtected.name}/get-health/policy'
  properties: {
    format: 'rawxml'
    value: healthOperationPolicyXml
  }
  dependsOn: [
    // apiProtected is referenced via the resource name string above,
    // creating an implicit dependency — no need to list it explicitly.
    // apiProtectedPolicy is sequenced first so the API-level inbound
    // policy lands before this per-operation override (predictable apply
    // order in case APIM evaluates policy chains during apply).
    apiProtectedPolicy
  ]
}

// -----------------------------------------------------------------------------
// Custom product `clearai` — explicit replacement for the built-in `unlimited`
// product (which on Consumption tier isn't always present at deploy time).
// Subscription keys minted under this product unlock the protected API.
// -----------------------------------------------------------------------------

resource product 'Microsoft.ApiManagement/service/products@2024-05-01' = {
  parent: apim
  name: 'clearai'
  properties: {
    displayName: 'ClearAI'
    description: 'ClearAI backend access. Auth is via Entra-issued JWT (validate-jwt on the API), not via subscription key — the product is kept for organisational grouping only.'
    subscriptionRequired: false
    // approvalRequired intentionally omitted: APIM rejects the field with
    // "Cannot provide value for approvalRequired when no subscriptions are
    // required" when subscriptionRequired=false.
    state: 'published'
  }
}

resource productApiLink 'Microsoft.ApiManagement/service/products/apis@2024-05-01' = {
  parent: product
  name: apiProtected.name
}

// -----------------------------------------------------------------------------
// Diagnostic settings — forward APIM logs/metrics to Log Analytics
// -----------------------------------------------------------------------------
// GatewayLogs: one row per request reaching the gateway. Includes caller IP,
//   subscription ID, operation name, backend response time, total time, status.
// GatewayMetrics: aggregate request rate, capacity, EventHub-friendly counters.
// AllMetrics: platform metrics (Requests, Capacity, Duration) — already in
//   Azure Monitor metrics, but emitting them here lets you cross-join with
//   the log table in a single KQL query.
//
// `name` on diagnosticSettings is a child-resource name, not the resource
// name — keep it short and stable so re-deploys don't create a second one.

resource apimDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: apim
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'GatewayLogs'
        enabled: true
      }
      {
        category: 'WebSocketConnectionLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

output apimName string = apim.name
output gatewayUrl string = apim.properties.gatewayUrl
output principalId string = apim.identity.principalId
output productName string = product.name
