// =============================================================================
// API Management (Consumption tier) — ClearAI dev gateway
// =============================================================================
// - SKU: Consumption (capacity 0). No VNet, no custom domain.
// - System-assigned managed identity (used to read the shared secret from KV).
// - Two APIs:
//     1. `clearai-backend`         (path '', subscriptionRequired: true)
//        operations: POST /classify/describe, /classify/expand, /boost,
//                    GET  /classify/newDescription,
//                    GET  /trace/{eventId},
//                    POST /trace/{eventId}/feedback
//     2. `clearai-backend-public`  (path 'health', subscriptionRequired: false)
//        operation: GET / (which proxies to {backend}/health)
//   They MUST live on different paths because APIM rejects two HTTPS APIs
//   sharing the same path unless they're in a version set, and a version set
//   adds gateway-URL noise we don't want for v1.
//
//   So the gateway URLs are:
//     POST https://{apim}.azure-api.net/classify/describe       (sub key required)
//     POST https://{apim}.azure-api.net/classify/expand         (sub key required)
//     GET  https://{apim}.azure-api.net/classify/newDescription (sub key required)
//     POST https://{apim}.azure-api.net/boost                   (sub key required)
//     GET  https://{apim}.azure-api.net/trace/{eventId}         (sub key required)
//     POST https://{apim}.azure-api.net/trace/{eventId}/feedback (sub key required)
//     GET  https://{apim}.azure-api.net/health                  (anonymous)
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

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------
// Derived
// -----------------------------------------------------------------------------

// The inbound policy — same XML on both APIs. exists-action="delete" to
// defeat header-spoofing, then exists-action="override" to re-inject from
// the named-value.
//
// On rate limiting:
//   `rate-limit-by-key` is NOT available on the Consumption SKU (the docs
//   table marks it "all except Consumption"). The simple `rate-limit` policy
//   IS available and rate-limits per subscription. For the public /health
//   API which has no subscription, `rate-limit` has no effect — defence on
//   that path comes from the Fastify in-process limiter (allowList exempts
//   /health for liveness probes) and Container Apps' replica autoscaler.
// CORS allow-list. Browser-side callers are the SWA (auto-hostname and
// the custom domain); the gateway origin is included so server-to-server
// smoke tests (curl from CI / from the gateway URL itself) work; the two
// localhost ports are Vite (5173) and Astro dev (4321) for local browser
// sessions hitting prod APIM directly. Keep this list in sync with
// `CORS_ORIGINS` in containerapp.bicep — both layers must allow the same
// origins or the second layer rejects after APIM passes.
var corsAllowedOrigins = [
  'https://apim-infp-clearai-be-dev-gwc-01.azure-api.net'
  'http://localhost:5173'
  'http://localhost:4321'
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

var apiInboundPolicyXml = '<policies>\n  <inbound>\n    <base />\n    <cors allow-credentials="false">\n      <allowed-origins>\n${corsOriginXml}\n      </allowed-origins>\n      <allowed-methods preflight-result-max-age="600">\n        <method>GET</method>\n        <method>POST</method>\n        <method>OPTIONS</method>\n      </allowed-methods>\n      <allowed-headers>\n        <header>content-type</header>\n        <header>ocp-apim-subscription-key</header>\n      </allowed-headers>\n    </cors>\n    <set-header name="x-apim-shared-secret" exists-action="delete" />\n    <set-header name="x-apim-shared-secret" exists-action="override">\n      <value>{{apim-shared-secret}}</value>\n    </set-header>\n    <rate-limit calls="60" renewal-period="60" />\n  </inbound>\n  <backend>\n    <base />\n  </backend>\n  <outbound>\n    <base />\n  </outbound>\n  <on-error>\n    <base />\n  </on-error>\n</policies>'

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
    description: 'Protected ClearAI backend operations. Requires subscription key.'
    path: ''   // mounted at root
    protocols: [ 'https' ]
    serviceUrl: backendUrl
    subscriptionRequired: true
    subscriptionKeyParameterNames: {
      header: 'Ocp-Apim-Subscription-Key'
      query: 'subscription-key'
    }
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

resource opDescribe 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'classify-describe'
  properties: {
    displayName: 'POST /classify/describe'
    method: 'POST'
    urlTemplate: '/classify/describe'
    responses: [
      { statusCode: 200, description: 'OK' }
    ]
  }
}

resource opExpand 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'classify-expand'
  properties: {
    displayName: 'POST /classify/expand'
    method: 'POST'
    urlTemplate: '/classify/expand'
    responses: [
      { statusCode: 200, description: 'OK' }
    ]
  }
}

resource opBoost 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'boost'
  properties: {
    displayName: 'POST /boost'
    method: 'POST'
    urlTemplate: '/boost'
    responses: [
      { statusCode: 200, description: 'OK' }
    ]
  }
}

// Lazy ZATCA-safe submission text — generated on demand from a prior
// classification's request_id so /classify/describe can return without
// paying ~3-5s of LLM time. Frontend calls this when the user clicks
// "Copy submission text" (or equivalent).
resource opNewDescription 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'classify-new-description'
  properties: {
    displayName: 'GET /classify/newDescription'
    method: 'GET'
    urlTemplate: '/classify/newDescription'
    templateParameters: []
    request: {
      queryParameters: [
        {
          name: 'request_id'
          description: 'UUID of a prior classify/describe response.'
          type: 'string'
          required: true
        }
      ]
    }
    responses: [
      { statusCode: 200, description: 'OK' }
      { statusCode: 400, description: 'invalid_query or invalid_state' }
      { statusCode: 404, description: 'not_found' }
    ]
  }
}

// Trace replay — fetches the persisted classification_event row + any
// human feedback rows for a prior request_id. Powers the trace page UI
// where users can review WHY a code was chosen and submit corrections.
//
// Path is templated on {eventId} (UUID); APIM forwards verbatim. The
// backend's Fastify route validates the UUID shape and returns 404
// for malformed IDs OR missing rows — APIM doesn't try to enforce
// the UUID format at the gateway because the backend's error message
// is more useful ("invalid event id" vs "no event with that id").
resource opTraceGet 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'trace-get'
  properties: {
    displayName: 'GET /trace/{eventId}'
    method: 'GET'
    urlTemplate: '/trace/{eventId}'
    templateParameters: [
      {
        name: 'eventId'
        description: 'UUID of a prior classification event (request_id from /classify/describe).'
        type: 'string'
        required: true
      }
    ]
    responses: [
      { statusCode: 200, description: 'Event found; returns event row + feedback array.' }
      { statusCode: 404, description: 'Invalid UUID or no event with that id.' }
    ]
  }
}

// User feedback on a classification — confirm / reject / prefer_alternative.
// One row per (event_id, user_id) — UPSERT semantics on the backend, so a
// repeat POST from the same user updates their existing feedback rather
// than spamming duplicates.
resource opTraceFeedback 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: apiProtected
  name: 'trace-feedback'
  properties: {
    displayName: 'POST /trace/{eventId}/feedback'
    method: 'POST'
    urlTemplate: '/trace/{eventId}/feedback'
    templateParameters: [
      {
        name: 'eventId'
        description: 'UUID of the classification event being annotated.'
        type: 'string'
        required: true
      }
    ]
    responses: [
      { statusCode: 200, description: 'Feedback recorded; returns feedback_id.' }
      { statusCode: 400, description: 'invalid_body — malformed payload or wrong field combination.' }
      { statusCode: 404, description: 'Invalid UUID or no event with that id.' }
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
  properties: {
    format: 'rawxml'
    value: apiInboundPolicyXml
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
    description: 'ClearAI backend access — gates POST /classify/* and POST /boost.'
    subscriptionRequired: true
    approvalRequired: false
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
