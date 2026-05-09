// =============================================================================
// Key Vault (Standard SKU, RBAC mode)
// =============================================================================
// Network posture is environment-gated:
//   dev      -> public network on, defaultAction Allow + AzureServices bypass.
//               Container Apps Consumption can't bind to a Private Endpoint
//               without a Workload Profile env, so we lean on RBAC + the fact
//               that the only KV operation Container Apps does is
//               getSecret via secretref (audited).
//   stg/prod -> public network OFF; KV is reachable only via Private Endpoint.
//               Purge protection is forced on (cannot be undone — this is
//               intentional, prod KVs must never be purgeable).
//
// Other settings (constant across envs):
// - SKU: Standard
// - Soft-delete: enabled (Azure default, cannot be disabled)
// - RBAC mode (no access policies)
// - Cost: free for first 10k operations / month
// =============================================================================

@description('Region.')
param location string

@description('Environment short code. Drives network posture and purge protection.')
@allowed([ 'dev', 'stg', 'prd' ])
param environmentName string

@description('Key Vault name. Globally unique. Max 24 chars.')
@maxLength(24)
param keyVaultName string

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------

var isDev = environmentName == 'dev'

resource kv 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Purge protection: OFF for dev so we can blow the KV away during
    // experimentation. ON for stg/prod (irreversible — once enabled, the
    // vault cannot be purged for the soft-delete window even by an Owner).
    enablePurgeProtection: isDev ? null : true
    publicNetworkAccess: isDev ? 'Enabled' : 'Disabled'
    networkAcls: {
      defaultAction: isDev ? 'Allow' : 'Deny'
      bypass: 'AzureServices'
    }
  }
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

output name string = kv.name
output id string = kv.id
output uri string = kv.properties.vaultUri
