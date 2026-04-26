// =============================================================================
// Key Vault Secrets
// =============================================================================
// Seeds three secrets:
//   - postgres-password           : the generated 32-char admin password
//   - postgres-connection-string  : full sslmode=require URI
//   - anthropic-api-key           : real key OR '__REPLACE__' placeholder
//
// Re-running this module overwrites secret values (idempotent), but only when
// values change (Bicep diffs). To rotate, re-run deploy.sh with new values.
// =============================================================================

@description('Existing Key Vault name (created by keyvault.bicep).')
param keyVaultName string

@description('Postgres admin password.')
@secure()
param postgresPassword string

@description('Postgres connection string with sslmode=require.')
@secure()
param postgresConnectionString string

@description('Anthropic API key. Pass __REPLACE__ to seed a placeholder.')
@secure()
param anthropicApiKey string

// -----------------------------------------------------------------------------

resource kv 'Microsoft.KeyVault/vaults@2024-04-01-preview' existing = {
  name: keyVaultName
}

resource secretPostgresPassword 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = {
  parent: kv
  name: 'postgres-password'
  properties: {
    value: postgresPassword
    contentType: 'text/plain'
  }
}

resource secretPostgresConnString 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = {
  parent: kv
  name: 'postgres-connection-string'
  properties: {
    value: postgresConnectionString
    contentType: 'text/plain'
  }
}

resource secretAnthropicApiKey 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = {
  parent: kv
  name: 'anthropic-api-key'
  properties: {
    value: anthropicApiKey
    contentType: 'text/plain'
  }
}

// -----------------------------------------------------------------------------
// Outputs (just secret *names*, never values)
// -----------------------------------------------------------------------------

#disable-next-line outputs-should-not-contain-secrets
output pgPasswordSecretRef string = secretPostgresPassword.name
output pgConnStringSecretRef string = secretPostgresConnString.name
output anthropicSecretRef string = secretAnthropicApiKey.name
