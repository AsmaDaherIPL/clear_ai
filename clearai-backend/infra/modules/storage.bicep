// =============================================================================
// Storage Account + Blob container for ClearAI declaration-run artifacts
// =============================================================================
// - SKU: Standard_LRS (cheapest, single-region — fine for dev)
// - Kind: StorageV2 (general-purpose v2, required for blob lifecycle policies)
// - Access tier: Hot (we read recent runs frequently)
// - Auth: Entra ID only. Shared key access DISABLED. Public blob access OFF.
// - Network: public network access DISABLED, with Azure Services bypass.
//   This means:
//     - Container App MI (Microsoft trusted service) → can reach via backbone
//     - Azure Portal storage browser → works (also trusted)
//     - SPA in user's browser → CANNOT reach blob endpoint directly
//     - Operator laptop → blocked (must use Portal or temp firewall rule)
//   The SPA downloads files via user-delegation SAS URLs minted by the
//   Container App, NOT by talking to the storage endpoint directly.
// - Soft delete: 7 days (cheap insurance vs. accidental deletes)
// - Lifecycle: declaration-runs/* deleted after 90 days
//
// RBAC:
//   The Container App's system-assigned MI gets:
//     - Storage Blob Data Contributor (read/write blobs + create user-delegation SAS)
//   That role includes the right to call getUserDelegationKey, so a separate
//   Storage Blob Delegator assignment is NOT needed.
//
// Cost: <$1/month at dev volumes (single-digit GB, hot tier, LRS).
// =============================================================================

@description('Region. Must match the resource group region.')
param location string

@description('Environment short code. Drives network posture (dev = public+Allow, stg/prod = private only).')
@allowed([ 'dev', 'stg', 'prd' ])
param environmentName string

@description('Storage account name. 3-24 chars, lowercase alphanumeric only, globally unique.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Container App principal ID (system-assigned MI) to grant Storage Blob Data Contributor.')
param containerAppPrincipalId string

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------
// Built-in role definition IDs
// -----------------------------------------------------------------------------
// Storage Blob Data Contributor — read/write/delete blobs + getUserDelegationKey
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// -----------------------------------------------------------------------------
// Storage Account
// -----------------------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false           // MI/AAD auth only
    allowCrossTenantReplication: false
    defaultToOAuthAuthentication: true
    // SECOND Azure footgun discovered the hard way (2026-05-09):
    // The 'AzureServices' bypass is for genuinely *trusted Microsoft services*
    // like Event Grid, Backup, Defender — it does NOT cover Container Apps
    // Consumption tier outbound traffic. Setting defaultAction='Deny' +
    // bypass='AzureServices' BLOCKS the Container App MI and emits
    // "AuthorizationFailure: This request is not authorized to perform this
    // operation" on every blob write — the error reads like an RBAC issue
    // but is actually network-rule denial.
    //
    // FIRST footgun (also relevant): publicNetworkAccess='Disabled' on a
    // storage account ignores the networkAcls.bypass list entirely and
    // requires Private Endpoints. Container Apps Consumption can't bind to
    // a Private Endpoint without rebuilding the environment as Workload
    // Profiles + VNet, so PE is not viable for this tier either.
    //
    // For dev: defaultAction='Allow' is the pragmatic choice.
    //   Security is preserved by:
    //     - allowSharedKeyAccess: false  → no connection strings work
    //     - allowBlobPublicAccess: false → no anonymous reads
    //     - container publicAccess: None → ditto, per-container
    //     - RBAC only — only the Container App MI has Storage Blob Data Contributor
    //   Net: anonymous reads blocked, key-based auth blocked, only the MI
    //   can write/read. Lateral exposure is essentially nil.
    //
    // For prod: move to Container Apps Workload Profiles env + VNet, then
    // use a Private Endpoint and flip publicNetworkAccess to 'Disabled'.
    //
    // Environment gating: dev keeps the dev-pragmatic posture above. stg/prod
    // flip to publicNetworkAccess: Disabled which forces all traffic via
    // Private Endpoint. The PE is owned outside this module — typically by
    // the landing-zone team, wired against the Container Apps Workload
    // Profile env subnet. Deploy will succeed but runtime blob writes will
    // fail until the PE is in place; that's intentional fail-loud behaviour.
    publicNetworkAccess: environmentName == 'dev' ? 'Enabled' : 'Disabled'
    networkAcls: {
      defaultAction: environmentName == 'dev' ? 'Allow' : 'Deny'
      bypass: 'AzureServices'              // Harmless when defaultAction is Allow; ignored under PE-only
      ipRules: []
      virtualNetworkRules: []
    }
    encryption: {
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
      keySource: 'Microsoft.Storage'
    }
  }
}

// -----------------------------------------------------------------------------
// Blob service: enable soft-delete, container soft-delete
// -----------------------------------------------------------------------------

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7                              // Blob soft-delete window
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7                              // Container soft-delete window
    }
    isVersioningEnabled: false             // Off for dev (cost). Turn on for prod.
  }
}

// -----------------------------------------------------------------------------
// Container: declaration-runs
// -----------------------------------------------------------------------------

resource declarationRunsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: 'declaration-runs'
  properties: {
    publicAccess: 'None'                   // No anonymous reads
    metadata: {
      purpose: 'ZATCA declaration XML artifacts (HV bundles + LV chunks + manifest.json)'
    }
  }
}

// -----------------------------------------------------------------------------
// Lifecycle management policy: delete blobs in declaration-runs/* after 90 days
// -----------------------------------------------------------------------------
// IMPORTANT (Microsoft semantics — easy to misread):
// `prefixMatch` values MUST start with the CONTAINER NAME, not with a path
// inside the container. The trailing slash means "any blob name under this".
// So `'declaration-runs/'` = "the container named declaration-runs, every
// blob in it". Blobs stored at e.g. `naqel/2026/05/09/<runId>/input.csv`
// (where 'naqel' is the operator subfolder INSIDE the container) ARE
// matched — the operator subfolder is just part of the blob name and the
// rule covers all of them. When new operators land they need NO bicep
// change — same one-line rule covers them automatically.
// Ref: https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview#prefix-match

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2024-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-old-declaration-runs'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              // Container name + trailing slash = every blob in the container,
              // any operator subfolder, any depth.
              prefixMatch: [ 'declaration-runs/' ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 90
                }
              }
            }
          }
        }
      ]
    }
  }
}

// -----------------------------------------------------------------------------
// RBAC: grant Container App MI "Storage Blob Data Contributor" at account scope
// -----------------------------------------------------------------------------

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  // Deterministic GUID so re-runs are idempotent (no duplicate assignments).
  name: guid(storage.id, containerAppPrincipalId, storageBlobDataContributorRoleId)
  properties: {
    principalId: containerAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataContributorRoleId
    )
  }
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

output name string = storage.name
output id string = storage.id
output blobEndpoint string = storage.properties.primaryEndpoints.blob
output declarationRunsContainerName string = declarationRunsContainer.name
