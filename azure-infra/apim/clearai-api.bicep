// ============================================================================
// clearai-api.bicep
//
// Defines the ClearAI Backend API in an existing Azure API Management instance.
// Imports operations from clearai-backend/openapi.yaml. Wires inbound policies
// for: APIM shared-secret injection, Entra JWT validation, rate limiting, CORS.
//
// Scope: subscription-deploy-this-into-an-existing-RG. The APIM instance and
// the Container App backend are NOT created here — they're assumed to exist
// (provisioned by the broader infra Bicep tree). This file only manages the
// API definition + operations + policies inside that instance.
//
// Deployment:
//   az deployment group create \
//     --resource-group <rg> \
//     --template-file clearai-api.bicep \
//     --parameters clearai-api.params.json
// ============================================================================

@description('Name of the existing API Management instance.')
param apimName string

@description('Existing APIM API ID (slug). The API will be created/updated here.')
param apiId string = 'clearai-backend-v1'

@description('Display name shown in the developer portal.')
param apiDisplayName string = 'ClearAI Backend API'

@description('Path prefix this API is mounted at, after the APIM gateway URL.')
param apiPath string = 'api'

@description('URL of the Container App that hosts the backend (no trailing slash).')
param backendUrl string

@description('Entra tenant ID (issuer for the validate-jwt policy).')
param entraTenantId string

@description('Entra application (audience) ID expected on the bearer token.')
param entraAudience string = 'api://clearai-backend'

@description('Name of the Key Vault holding the APIM shared secret.')
param keyVaultName string

@description('Name of the Key Vault secret that stores the APIM shared-secret value.')
param apimSharedSecretSecretName string = 'apim-shared-secret'

@description('Comma-separated CORS origins (empty string = no CORS policy).')
param corsOrigins string = ''

@description('Per-IP rate limit: max requests per `windowSeconds`.')
param rateLimitMax int = 60

@description('Per-IP rate limit window in seconds.')
param rateLimitWindow int = 60

// ----------------------------------------------------------------------------
// Existing resources
// ----------------------------------------------------------------------------

resource apim 'Microsoft.ApiManagement/service@2023-09-01-preview' existing = {
  name: apimName
}

// ----------------------------------------------------------------------------
// Named values — APIM-shared-secret pulled from Key Vault
// ----------------------------------------------------------------------------

// The APIM instance must have a system-assigned managed identity that has
// `get` permission on the Key Vault secret. (Provisioned in the broader
// infra Bicep; verify before deploying this template.)

resource apimSharedSecretNamedValue 'Microsoft.ApiManagement/service/namedValues@2023-09-01-preview' = {
  parent: apim
  name: 'clearai-apim-shared-secret'
  properties: {
    displayName: 'clearai-apim-shared-secret'
    secret: true
    keyVault: {
      secretIdentifier: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/${apimSharedSecretSecretName}'
    }
  }
}

// ----------------------------------------------------------------------------
// API definition — imported from OpenAPI
// ----------------------------------------------------------------------------
// The OpenAPI YAML is loaded at deploy time. Update by:
//   1. Edit clearai-backend/openapi.yaml
//   2. Re-run this deployment

resource api 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = {
  parent: apim
  name: apiId
  properties: {
    displayName: apiDisplayName
    path: apiPath
    protocols: [
      'https'
    ]
    serviceUrl: backendUrl
    subscriptionRequired: false  // Auth comes from Entra JWT, not APIM subscription keys
    format: 'openapi'
    value: loadTextContent('../../clearai-backend/openapi.yaml')
  }
}

// ----------------------------------------------------------------------------
// Inbound policy — runs before every operation under this API
// ----------------------------------------------------------------------------
//
// Order matters:
//   1. validate-jwt          → reject unauthenticated traffic
//   2. set-header            → inject the APIM shared secret
//   3. rate-limit-by-key     → per-user per-IP throttling
//   4. cors                  → SPA browser preflight handling
//
// The probes (/health, /ready) are exempted by the operation-level policies
// further down (they override the API-level policy with <base/> + skip the
// validate-jwt step).

resource apiPolicy 'Microsoft.ApiManagement/service/apis/policies@2023-09-01-preview' = {
  parent: api
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: '''<policies>
      <inbound>
        <base />

        <!-- 1. Validate Microsoft Entra ID bearer token. -->
        <validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized" require-expiration-time="true" require-signed-tokens="true">
          <openid-config url="https://login.microsoftonline.com/${entraTenantId}/v2.0/.well-known/openid-configuration" />
          <audiences>
            <audience>${entraAudience}</audience>
          </audiences>
          <issuers>
            <issuer>https://login.microsoftonline.com/${entraTenantId}/v2.0</issuer>
          </issuers>
        </validate-jwt>

        <!-- 2. Strip the user bearer token; replace with the APIM shared secret. -->
        <set-header name="Authorization" exists-action="delete" />
        <set-header name="x-apim-shared-secret" exists-action="override">
          <value>{{clearai-apim-shared-secret}}</value>
        </set-header>

        <!-- 3. Rate limit per-IP. -->
        <rate-limit-by-key calls="${rateLimitMax}" renewal-period="${rateLimitWindow}" counter-key="@(context.Request.IpAddress)" />

        <!-- 4. CORS (only emitted when corsOrigins parameter is non-empty). -->
        ${empty(corsOrigins) ? '' : '<cors allow-credentials="false"><allowed-origins>${join(map(split(corsOrigins, \',\'), o => \'<origin>\${trim(o)}</origin>\'), \'\')}</allowed-origins><allowed-methods><method>GET</method><method>POST</method><method>PATCH</method><method>OPTIONS</method></allowed-methods><allowed-headers><header>content-type</header><header>authorization</header></allowed-headers></cors>'}
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
  }
}

// ----------------------------------------------------------------------------
// Per-operation overrides — probes need NO auth + NO rate limit
// ----------------------------------------------------------------------------
//
// /health and /ready operationIds come from the OpenAPI spec. The OpenAPI
// import auto-generates operationIds from the path + method:
//   GET /health → "get-health"
//   GET /ready  → "get-ready"
// (APIM lower-cases and dash-joins; verify after first import in case the
// generated IDs differ.)

resource healthPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2023-09-01-preview' = {
  name: '${apim.name}/${api.name}/get-health/policy'
  properties: {
    format: 'rawxml'
    value: '''<policies>
      <inbound>
        <!-- NO base/ : skip the API-level validate-jwt + rate-limit -->
        <set-header name="x-apim-shared-secret" exists-action="override">
          <value>{{clearai-apim-shared-secret}}</value>
        </set-header>
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
  }
  dependsOn: [
    apiPolicy
  ]
}

resource readyPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2023-09-01-preview' = {
  name: '${apim.name}/${api.name}/get-ready/policy'
  properties: {
    format: 'rawxml'
    value: '''<policies>
      <inbound>
        <set-header name="x-apim-shared-secret" exists-action="override">
          <value>{{clearai-apim-shared-secret}}</value>
        </set-header>
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
  }
  dependsOn: [
    apiPolicy
  ]
}

// ----------------------------------------------------------------------------
// Outputs
// ----------------------------------------------------------------------------

output apiResourceId string = api.id
output apimGatewayUrl string = 'https://${apim.properties.gatewayUrl}/${apiPath}'
