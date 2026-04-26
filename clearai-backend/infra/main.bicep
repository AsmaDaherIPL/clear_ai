// =============================================================================
// ClearAI - Dev Environment Orchestrator
// =============================================================================
// Subscription : sub-infp-clearai-nonprod-gwc
// Resource Grp : rg-infp-clearai-common-dev-gwc-01 (existing, shared)
// Region       : germanywestcentral
//
// This template is fully idempotent. Re-running with the same parameters
// converges to the same desired state. No destructive operations.
//
// Outputs are intentionally limited and contain NO secrets. The Postgres
// admin password and connection string live only inside Key Vault.
// =============================================================================

targetScope = 'resourceGroup'

// -----------------------------------------------------------------------------
// Parameters
// -----------------------------------------------------------------------------

@description('Azure region. Must match the resource group region.')
param location string = 'germanywestcentral'

@description('Environment short code (dev, stg, prd). Used in resource names.')
@allowed([ 'dev', 'stg', 'prd' ])
param environmentName string = 'dev'

@description('Application short code. Used in tags.')
param appName string = 'clearai'

// ---- Postgres ---------------------------------------------------------------

@description('Postgres server name (no suffix logic — explicit).')
param postgresServerName string = 'psql-infp-clearai-dev-gwc-01'

@description('Postgres database name created on the server.')
param postgresDatabaseName string = 'clearai'

@description('Postgres administrator login.')
param postgresAdminLogin string = 'clearai_admin'

@description('Postgres administrator password. Injected by deploy.sh.')
@secure()
param postgresAdminPassword string = ''

@description('Operator (developer) public IP for Postgres firewall allow. Injected by deploy.sh.')
param operatorIpAddress string = ''

// ---- Key Vault --------------------------------------------------------------

@description('Key Vault name. Globally unique, max 24 chars. No suffix retry.')
@maxLength(24)
param keyVaultName string = 'kv-infp-clearai-dev-gwc'

@description('Anthropic API key value. Pass empty string to seed a placeholder.')
@secure()
param anthropicApiKey string = ''

// ---- Container Apps ---------------------------------------------------------

@description('Container Apps Environment name.')
param containerAppsEnvName string = 'cae-infp-clearai-dev-gwc-01'

@description('Container App (backend) name.')
param containerAppName string = 'ca-infp-clearai-be-dev-gwc-01'

@description('Container image (full ref). Public GHCR image, no registry creds.')
param containerImage string = 'ghcr.io/asmadaheripl/clearai-backend:latest'

// ---- Network Watcher --------------------------------------------------------

@description('Set true to create a regional Network Watcher in this RG. Set false if NetworkWatcher_germanywestcentral already exists in NetworkWatcherRG (recommended).')
param createNetworkWatcher bool = false

@description('Network Watcher name (only used if createNetworkWatcher = true).')
param networkWatcherName string = 'nw-infp-clearai-dev-gwc-01'

// ---- Tags -------------------------------------------------------------------

@description('Common resource tags.')
param tags object = {
  app: appName
  env: environmentName
  managedBy: 'bicep'
  costCenter: 'clearai'
}

// -----------------------------------------------------------------------------
// Modules
// -----------------------------------------------------------------------------

// 1. Postgres Flexible Server + database + extensions + firewall
module postgres 'modules/postgres.bicep' = {
  name: 'postgres-deploy'
  params: {
    location: location
    serverName: postgresServerName
    databaseName: postgresDatabaseName
    administratorLogin: postgresAdminLogin
    administratorPassword: postgresAdminPassword
    operatorIpAddress: operatorIpAddress
    tags: tags
  }
}

// 2. Key Vault (RBAC mode, soft-delete on, purge protection off for dev)
module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault-deploy'
  params: {
    location: location
    keyVaultName: keyVaultName
    tags: tags
  }
}

// 3. Key Vault secrets (postgres password, conn string, anthropic key)
module keyVaultSecrets 'modules/keyvault-secrets.bicep' = {
  name: 'keyvault-secrets-deploy'
  params: {
    keyVaultName: keyVault.outputs.name
    postgresPassword: postgresAdminPassword
    postgresConnectionString: postgres.outputs.connectionString
    anthropicApiKey: empty(anthropicApiKey) ? '__REPLACE__' : anthropicApiKey
  }
}

// 4. Container Apps Environment (Consumption-only, no Log Analytics)
module containerAppsEnv 'modules/containerapps-env.bicep' = {
  name: 'cae-deploy'
  params: {
    location: location
    environmentName: containerAppsEnvName
    tags: tags
  }
}

// 5. Container App (backend) — system-assigned MI, secretref to KV
module containerApp 'modules/containerapp.bicep' = {
  name: 'ca-deploy'
  params: {
    location: location
    containerAppName: containerAppName
    containerAppsEnvId: containerAppsEnv.outputs.id
    image: containerImage
    keyVaultName: keyVault.outputs.name
    tags: tags
  }
  dependsOn: [
    keyVaultSecrets
  ]
}

// 6. (Optional) Network Watcher — only if your sub does not already
//    have NetworkWatcher_germanywestcentral in NetworkWatcherRG.
module networkWatcher 'modules/networkwatcher.bicep' = if (createNetworkWatcher) {
  name: 'nw-deploy'
  params: {
    location: location
    networkWatcherName: networkWatcherName
    tags: tags
  }
}

// -----------------------------------------------------------------------------
// Outputs (no secrets)
// -----------------------------------------------------------------------------

output resourceGroupName string = resourceGroup().name
output location string = location

output postgresServerName string = postgres.outputs.serverName
output postgresFqdn string = postgres.outputs.fqdn
output postgresDatabaseName string = postgresDatabaseName

output keyVaultName string = keyVault.outputs.name
output keyVaultUri string = keyVault.outputs.uri

output containerAppsEnvName string = containerAppsEnv.outputs.name
output containerAppName string = containerApp.outputs.name
output containerAppFqdn string = containerApp.outputs.fqdn
output containerAppPrincipalId string = containerApp.outputs.principalId
