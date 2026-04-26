// =============================================================================
// API Management (Consumption tier) — ClearAI dev gateway
// =============================================================================
// - SKU: Consumption (capacity 0). No VNet, no custom domain.
// - System-assigned managed identity (used to read the shared secret from KV).
// - Two APIs:
//     1. `clearai-backend`         (path '', subscriptionRequired: true)
//        operations: POST /classify/describe, /classify/expand, /boost
//     2. `clearai-backend-public`  (path 'health', subscriptionRequired: false)
//        operation: GET / (which proxies to {backend}/health)
//   They MUST live on different paths because APIM rejects two HTTPS APIs
//   sharing the same path unless they're in a version set, and a version set
//   adds gateway-URL noise we don't want for v1.
//
//   So the gateway URLs are:
//     POST https://{apim}.azure-api.net/classify/describe   (sub key required)
//     POST https://{apim}.azure-api.net/classify/expand     (sub key required)
//     POST https://{apim}.azure-api.net/boost               (sub key required)
//     GET  https://{apim}.azure-api.net/health              (anonymous)
//
// - Inbound API policy (applied to BOTH APIs):
//     a) Strip any client-supplied x-apim-shared-secret header (anti-spoof)
//     b) Re-inject x-apim-shared-secret from a named-value
//     c) Rate limit per subscription, 60 req/min  (rate-limit-by-key isn't
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
var apiInboundPolicyXml = '''<policies>
  <inbound>
    <base />
    <set-header name="x-apim-shared-secret" exists-action="delete" />
    <set-header name="x-apim-shared-secret" exists-action="override">
      <value>{{apim-shared-secret}}</value>
    </set-header>
    <rate-limit calls="60" renewal-period="60" />
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>'''

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
// Outputs
// -----------------------------------------------------------------------------

output apimName string = apim.name
output gatewayUrl string = apim.properties.gatewayUrl
output principalId string = apim.identity.principalId
output productName string = product.name
