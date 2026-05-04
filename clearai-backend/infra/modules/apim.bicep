// =============================================================================
// API Management (Consumption tier) — ClearAI dev gateway
// =============================================================================
// - SKU: Consumption (capacity 0). No VNet, no custom domain.
// - System-assigned managed identity (used to read the shared secret from KV).
// - Two APIs:
//     1. `clearai-backend`         (path '', subscriptionRequired: true)
//        operations on /classifications:
//          POST  /classifications
//          POST  /classifications/expand
//          GET   /classifications/{id}
//          POST  /classifications/{id}/submission-description
//          POST  /classifications/{id}/feedback
//     2. `clearai-backend-public`  (path 'health', subscriptionRequired: false)
//        operation: GET / (which proxies to {backend}/health)
//   They MUST live on different paths because APIM rejects two HTTPS APIs
//   sharing the same path unless they're in a version set, and a version set
//   adds gateway-URL noise we don't want for v1.
//
//   So the gateway URLs are:
//     POST https://{apim}.azure-api.net/classifications                              (sub key required)
//     POST https://{apim}.azure-api.net/classifications/expand                       (sub key required)
//     GET  https://{apim}.azure-api.net/classifications/{id}                         (sub key required)
//     POST https://{apim}.azure-api.net/classifications/{id}/submission-description  (sub key required)
//     POST https://{apim}.azure-api.net/classifications/{id}/feedback                (sub key required)
//     GET  https://{apim}.azure-api.net/health                                       (anonymous)
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

var apiInboundPolicyXml = '<policies>\n  <inbound>\n    <base />\n    <cors allow-credentials="false">\n      <allowed-origins>\n${corsOriginXml}\n      </allowed-origins>\n      <allowed-methods preflight-result-max-age="600">\n        <method>GET</method>\n        <method>POST</method>\n        <method>OPTIONS</method>\n      </allowed-methods>\n      <allowed-headers>\n        <header>content-type</header>\n        <header>authorization</header>\n        <header>accept-language</header>\n      </allowed-headers>\n    </cors>\n    <validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized — bearer token missing or invalid" require-scheme="Bearer" require-signed-tokens="true" require-expiration-time="true">\n      <openid-config url="${entraOidcUrl}" />\n      <audiences>\n        <audience>${entraApiAppIdUri}</audience>\n${altAudienceXml}      </audiences>\n      <issuers>\n        <issuer>${entraIssuer}</issuer>\n      </issuers>\n    </validate-jwt>\n    <set-header name="x-apim-shared-secret" exists-action="delete" />\n    <set-header name="x-apim-shared-secret" exists-action="override">\n      <value>{{apim-shared-secret}}</value>\n    </set-header>\n    <rate-limit calls="60" renewal-period="60" />\n  </inbound>\n  <backend>\n    <base />\n  </backend>\n  <outbound>\n    <base />\n  </outbound>\n  <on-error>\n    <base />\n  </on-error>\n</policies>'

// Anonymous policy for the public /health probe — same CORS + shared-secret
// injection as above, but NO validate-jwt, NO rate-limit. This is what
// Container Apps probes hit and what the BFF probe hits without a token.
var publicInboundPolicyXml = '<policies>\n  <inbound>\n    <base />\n    <cors allow-credentials="false">\n      <allowed-origins>\n${corsOriginXml}\n      </allowed-origins>\n      <allowed-methods preflight-result-max-age="600">\n        <method>GET</method>\n      </allowed-methods>\n      <allowed-headers>\n        <header>content-type</header>\n      </allowed-headers>\n    </cors>\n    <set-header name="x-apim-shared-secret" exists-action="delete" />\n    <set-header name="x-apim-shared-secret" exists-action="override">\n      <value>{{apim-shared-secret}}</value>\n    </set-header>\n    <return-response>\n      <set-status code="200" reason="OK" />\n      <set-header name="Content-Type" exists-action="override">\n        <value>application/json</value>\n      </set-header>\n      <set-body>{"status":"ok"}</set-body>\n    </return-response>\n  </inbound>\n  <backend>\n    <base />\n  </backend>\n  <outbound>\n    <base />\n  </outbound>\n  <on-error>\n    <base />\n  </on-error>\n</policies>'

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
// Named value — placeholder inline value, flipped to KV-backed by deploy.sh.
// -----------------------------------------------------------------------------
// We intentionally do NOT set `keyVault: { secretIdentifier: ... }` here.
// At Bicep apply time APIM tries to read the KV secret using its system MI,
// but that MI was just created and has no role on the KV yet — so the apply
// fails with `Caller is not authorized`. deploy.sh handles the role grant
// then re-issues `az apim nv update --secret true ...` to flip this to
// KV-backed. From that point on, rotation is `az keyvault secret set` and
// APIM auto-refreshes via its MI.

resource sharedSecretNamedValue 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'apim-shared-secret'
  properties: {
    displayName: 'apim-shared-secret'
    secret: true
    value: '__bootstrap_replaced_by_deploy_sh__'
  }
}

// -----------------------------------------------------------------------------
// API #1 — clearai-backend (protected, subscriptionRequired: true)
// -----------------------------------------------------------------------------

resource apiProtected 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'clearai-backend'
  properties: {
    displayName: 'ClearAI Backend'
    description: 'Protected ClearAI backend operations. Requires Entra-issued bearer token (validate-jwt policy). No subscription key — that mechanism was retired in the Option A cutover (frontend security review C1).'
    path: ''   // mounted at root
    protocols: [ 'https' ]
    serviceUrl: backendUrl
    // No APIM subscription key — JWT is the sole auth gate. The
    // `validate-jwt` policy in the inbound XML rejects unauthenticated
    // requests with 401 before they reach the backend. Multiple frontends
    // (the Astro SPA's BFF today, mobile/partner BFFs in future) each
    // register as their own confidential client in the same Workforce
    // tenant; APIM trusts JWTs whose audience matches the API app
    // registration regardless of which client issued them.
    subscriptionRequired: false
    apiType: 'http'
    type: 'http'
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
// Operations on apiProtected
// -----------------------------------------------------------------------------
// All 5 operations live under /classifications — the resource — with the
// HTTP verb describing what's happening to it. Methods chosen by the
// "would I be upset if a flaky proxy replayed this 10x?" rule:
//   - POST whenever an LLM call burns tokens or a row is written
//   - GET only for pure DB reads (currently just GET /classifications/{id})
//
// Names use the URL pattern as the primary token so the operation list
// reads naturally when sorted alphabetically:
//   classifications-create / classifications-expand / classifications-feedback
//   classifications-get / classifications-submission-description

// POST /classifications — primary classification endpoint.
// Free-text product description in, full classification envelope out
// (chosen code, alternatives, rationale, procedures, duty, …). Writes
// one classification_events row and runs up to 3 LLM calls.
resource opClassificationsCreate 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'classifications-create'
  properties: {
    displayName: 'POST /classifications'
    method: 'POST'
    urlTemplate: '/classifications'
    templateParameters: []
    responses: [
      { statusCode: 200, description: 'Classification produced — returns the full envelope.' }
      { statusCode: 400, description: 'invalid_body — malformed description payload.' }
    ]
  }
}

// POST /classifications/expand — narrow a parent prefix (4–10 digits) to
// a 12-digit leaf. Used when the user has a heading-level code and wants
// to refine to a leaf via a fuller description. Writes its own
// classification_events row.
resource opClassificationsExpand 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'classifications-expand'
  properties: {
    displayName: 'POST /classifications/expand'
    method: 'POST'
    urlTemplate: '/classifications/expand'
    templateParameters: []
    responses: [
      { statusCode: 200, description: 'Expanded under the parent prefix.' }
      { statusCode: 400, description: 'invalid_body — bad code or description.' }
    ]
  }
}

// GET /classifications/{id} — fetch a persisted classification + any
// human feedback rows. Pure DB read, no LLM, idempotent → GET is correct.
// Powers the trace UI where users can review WHY a code was chosen.
resource opClassificationsGet 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'classifications-get'
  properties: {
    displayName: 'GET /classifications/{id}'
    method: 'GET'
    urlTemplate: '/classifications/{id}'
    templateParameters: [
      {
        name: 'id'
        description: 'UUID returned by POST /classifications.'
        type: 'string'
        required: true
      }
    ]
    responses: [
      { statusCode: 200, description: 'Classification + feedback array.' }
      { statusCode: 404, description: 'Invalid UUID or no classification with that id.' }
    ]
  }
}

// POST /classifications/{id}/submission-description — generate a customs-
// grade Arabic description (with EN companion) suitable for the ZATCA
// item submission form. Lazy: the classify endpoint no longer produces
// this inline (saves ~3-5s on every accepted classification). Frontend
// calls this when the user is ready to copy text into the declaration.
//
// Why POST not GET: every call burns Haiku tokens. POST stops browsers /
// proxies / CDNs from auto-replaying the request and keeps the URL out
// of access logs.
resource opClassificationsSubmissionDescription 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'classifications-submission-description'
  properties: {
    displayName: 'POST /classifications/{id}/submission-description'
    method: 'POST'
    urlTemplate: '/classifications/{id}/submission-description'
    templateParameters: [
      {
        name: 'id'
        description: 'UUID of a prior classification.'
        type: 'string'
        required: true
      }
    ]
    responses: [
      { statusCode: 200, description: 'Generated submission description (AR + EN).' }
      { statusCode: 400, description: 'invalid_state — classification is not on a 12-digit accepted path.' }
      { statusCode: 404, description: 'Invalid UUID or no classification with that id.' }
      { statusCode: 500, description: 'generation_failed — generator returned no text.' }
    ]
  }
}

// POST /classifications/{id}/feedback — record human feedback on a
// classification (confirm / reject / prefer_alternative). UPSERT-on-
// (event_id, user_id) so a repeat POST from the same user updates their
// existing feedback rather than spamming duplicates.
resource opClassificationsFeedback 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'classifications-feedback'
  properties: {
    displayName: 'POST /classifications/{id}/feedback'
    method: 'POST'
    urlTemplate: '/classifications/{id}/feedback'
    templateParameters: [
      {
        name: 'id'
        description: 'UUID of the classification being annotated.'
        type: 'string'
        required: true
      }
    ]
    responses: [
      { statusCode: 200, description: 'Feedback recorded — returns feedback_id.' }
      { statusCode: 400, description: 'invalid_body — malformed payload or wrong field combination.' }
      { statusCode: 404, description: 'Invalid UUID or no classification with that id.' }
    ]
  }
}

// -----------------------------------------------------------------------------
// API #2 — clearai-backend-public (anonymous /health probe)
// -----------------------------------------------------------------------------
// Path is `health` (NOT root) because APIM forbids two non-versioned HTTPS
// APIs on the same path. The serviceUrl is the FULL backend /health URL, and
// the operation's urlTemplate is `/`, so the gateway URL collapses cleanly:
//
//   GET https://{apim}.azure-api.net/health
//     → backend GET https://{ca}/health
//
// This is what the spec asks for (anonymous /health on the gateway) without
// touching the protected API's paths.

resource apiPublic 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'clearai-backend-public'
  properties: {
    displayName: 'ClearAI Backend (public probe)'
    description: 'Anonymous /health probe through the gateway.'
    path: 'health'
    protocols: [ 'https' ]
    serviceUrl: '${backendUrl}/health'
    subscriptionRequired: false
    apiType: 'http'
    type: 'http'
  }
}

resource apiPublicPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: apiPublic
  name: 'policy'
  // Short-circuits with `{"status":"ok"}` directly from APIM — no
  // backend hop. This closes the I1 finding from the frontend security
  // review (anonymous /health used to leak `db: true` confirming the
  // database was reachable). For richer health (db connectivity etc.)
  // hit the backend's /ready probe via the protected API with a JWT.
  properties: {
    format: 'rawxml'
    value: publicInboundPolicyXml
  }
  dependsOn: [
    sharedSecretNamedValue
  ]
}

resource opHealth 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiPublic
  name: 'get'
  properties: {
    displayName: 'GET /health (proxied)'
    method: 'GET'
    urlTemplate: '/'
    responses: [
      { statusCode: 200, description: 'OK' }
    ]
  }
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
