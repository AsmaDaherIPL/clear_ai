// =============================================================================
// Key Vault (Standard SKU, RBAC mode)
// =============================================================================
// - Soft-delete: enabled (Azure default, cannot be disabled)
// - Purge protection: OFF for dev (TODO: turn ON for prod)
// - Access model: RBAC (no access policies)
// - Public network access: Enabled (no PE in dev)
// - Cost: free for first 10k operations / month
// =============================================================================

@description('Region.')
param location string

@description('Key Vault name. Globally unique. Max 24 chars.')
@maxLength(24)
param keyVaultName string

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------

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
    enablePurgeProtection: null  // OFF for dev. Set to true in prod.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
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
