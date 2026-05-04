// =============================================================================
// Key Vault Secrets
// =============================================================================
// Seeds the secrets the platform needs:
//   - postgres-password                       admin password (legacy break-glass)
//   - postgres-connection-string              admin conn string (legacy)
//   - anthropic-api-key                       Anthropic / Foundry key
//
//   Phase 2.1 additions (backend security review H3):
//   - postgres-app-connection-string          clearai_app conn string
//   - postgres-migrator-connection-string     clearai_migrator conn string
//   - postgres-readonly-connection-string     clearai_readonly conn string
//
// The three new conn-string secrets are CONDITIONAL: when their parameter
// is empty (first deploy, before role passwords are minted) we don't write
// the secret at all. deploy.sh runs a follow-up step that mints the
// passwords, runs the role-creation migration, and re-runs Bicep with the
// passwords populated.
//
// Re-running this module overwrites secret values (idempotent), but only
// when values change (Bicep diffs).
// =============================================================================

@description('Existing Key Vault name (created by keyvault.bicep).')
param keyVaultName string

@description('Postgres admin password.')
@secure()
param postgresPassword string

@description('Postgres admin connection string (sslmode=require).')
@secure()
param postgresConnectionString string

@description('Anthropic API key. Pass __REPLACE__ to seed a placeholder.')
@secure()
param anthropicApiKey string

// Phase 2.1 — three new role connection strings. Empty when not yet
// minted; resource creation is gated on non-empty.
@description('Phase 2.1: clearai_app connection string. Empty to skip writing this secret.')
@secure()
param postgresAppConnectionString string = ''

@description('Phase 2.1: clearai_migrator connection string. Empty to skip writing this secret.')
@secure()
param postgresMigratorConnectionString string = ''

@description('Phase 2.1: clearai_readonly connection string. Empty to skip writing this secret.')
@secure()
param postgresReadonlyConnectionString string = ''

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

// Phase 2.1 — conditional secrets for the three role-separated logins.
resource secretPostgresAppConnString 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = if (!empty(postgresAppConnectionString)) {
  parent: kv
  name: 'postgres-app-connection-string'
  properties: {
    value: postgresAppConnectionString
    contentType: 'text/plain'
  }
}

resource secretPostgresMigratorConnString 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = if (!empty(postgresMigratorConnectionString)) {
  parent: kv
  name: 'postgres-migrator-connection-string'
  properties: {
    value: postgresMigratorConnectionString
    contentType: 'text/plain'
  }
}

resource secretPostgresReadonlyConnString 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = if (!empty(postgresReadonlyConnectionString)) {
  parent: kv
  name: 'postgres-readonly-connection-string'
  properties: {
    value: postgresReadonlyConnectionString
    contentType: 'text/plain'
  }
}

// -----------------------------------------------------------------------------
// Outputs (just secret *names*, never values)
// -----------------------------------------------------------------------------

#disable-next-line outputs-should-not-contain-secrets
output pgPasswordSecretRef string = secretPostgresPassword.name
#disable-next-line outputs-should-not-contain-secrets
output pgConnStringSecretRef string = secretPostgresConnString.name
#disable-next-line outputs-should-not-contain-secrets
output anthropicSecretRef string = secretAnthropicApiKey.name
