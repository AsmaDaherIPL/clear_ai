// =============================================================================
// Container App (ClearAI Backend)
// =============================================================================
// - System-assigned managed identity (used to read KV secrets at runtime)
// - Public image on GHCR — no registry credentials
// - HTTPS-only ingress on port 3000
// - Scale: min 0, max 2; rule = concurrentRequests:10
// - Resources: 0.5 vCPU, 1 GiB
// - Probes: liveness + readiness on GET /health
// - Secrets sourced from Key Vault via secretref
//
// NOTE on KV secret access:
// The Container App's system-assigned MI gets the principalId emitted as
// output. deploy.sh assigns the 'Key Vault Secrets User' role on the KV
// AFTER this deploy completes (avoids a chicken-and-egg with role propagation).
// On the FIRST deploy the secretref values resolve once the role assignment
// finishes propagating and the next revision picks them up. deploy.sh handles
// this by triggering a single revision restart at the end.
// =============================================================================

@description('Region.')
param location string

@description('Container App name.')
param containerAppName string

@description('Container Apps Environment resource ID.')
param containerAppsEnvId string

@description('Container image (full ref). Public GHCR image.')
param image string

@description('Key Vault name (used to construct secret URIs).')
param keyVaultName string

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------
// Derived values
// -----------------------------------------------------------------------------

var kvUri = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}'

// -----------------------------------------------------------------------------

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: containerAppsEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      secrets: [
        {
          name: 'postgres-connection-string'
          keyVaultUrl: '${kvUri}/secrets/postgres-connection-string'
          identity: 'system'
        }
        {
          name: 'anthropic-api-key'
          keyVaultUrl: '${kvUri}/secrets/anthropic-api-key'
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'clearai-backend'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'LOG_LEVEL', value: 'info' }
            // Secrets via secretref
            { name: 'DATABASE_URL', secretRef: 'postgres-connection-string' }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            // Foundry / model placeholders — fill once Foundry rename is done
            { name: 'ANTHROPIC_BASE_URL', value: '__REPLACE__' }
            { name: 'LLM_MODEL', value: '__REPLACE__' }
            { name: 'LLM_MODEL_STRONG', value: '__REPLACE__' }
            { name: 'LLM_TIMEOUT_MS', value: '15000' }
            // Embedder
            { name: 'EMBEDDER_MODEL', value: 'Xenova/multilingual-e5-small' }
            { name: 'EMBEDDER_DIM', value: '384' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 15
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 15
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

output id string = app.id
output name string = app.name
output fqdn string = app.properties.configuration.ingress.fqdn
output principalId string = app.identity.principalId
