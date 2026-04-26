// =============================================================================
// ClearAI - Dev Parameters
// =============================================================================
// Used with: az deployment group create --parameters main.dev.bicepparam
//
// IMPORTANT: postgresAdminPassword, anthropicApiKey, and operatorIpAddress
// are injected by deploy.sh at deploy time. Do NOT hard-code them here.
// =============================================================================

using './main.bicep'

param location = 'germanywestcentral'
param environmentName = 'dev'
param appName = 'clearai'

// ---- Postgres ----
param postgresServerName = 'psql-infp-clearai-dev-gwc-01'
param postgresDatabaseName = 'clearai'
param postgresAdminLogin = 'clearai_admin'
// param postgresAdminPassword = <injected by deploy.sh>
// param operatorIpAddress    = <injected by deploy.sh>

// ---- Key Vault ----
param keyVaultName = 'kv-infp-clearai-dev-gwc'
// param anthropicApiKey = <injected by deploy.sh; defaults to '__REPLACE__'>

// ---- Container Apps ----
param containerAppsEnvName = 'cae-infp-clearai-dev-gwc-01'
param containerAppName = 'ca-infp-clearai-be-dev-gwc-01'
param containerImage = 'ghcr.io/asmadaheripl/clearai-backend:latest'

// ---- Network Watcher ----
// Most subs already have NetworkWatcher_germanywestcentral in NetworkWatcherRG.
// deploy.sh detects this and only sets createNetworkWatcher=true if missing.
param createNetworkWatcher = false
param networkWatcherName = 'nw-infp-clearai-dev-gwc-01'

// ---- Tags ----
param tags = {
  app: 'clearai'
  env: 'dev'
  managedBy: 'bicep'
  costCenter: 'clearai'
}
