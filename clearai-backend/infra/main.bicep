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

@description('Phase 2.1: app role (clearai_app) password. Empty until first cutover deploy.')
@secure()
param postgresAppPassword string = ''

@description('Phase 2.1: migrator role (clearai_migrator) password.')
@secure()
param postgresMigratorPassword string = ''

@description('Phase 2.1: readonly role (clearai_readonly) password.')
@secure()
param postgresReadonlyPassword string = ''

@description('Phase 2.1: flip the Container App over to least-privilege DB roles. Set to true on the cutover deploy after the role-creation migration has applied and the new KV secrets exist.')
param useRoleSeparation bool = false

@description('Operator (developer) public IP for Postgres firewall allow. Injected by deploy.sh.')
param operatorIpAddress string = ''

// ---- Key Vault --------------------------------------------------------------

@description('Key Vault name. Globally unique, max 24 chars. No suffix retry.')
@maxLength(24)
param keyVaultName string = 'kv-infp-clearai-dev-gwc'

@description('Anthropic API key value. Pass empty string to seed a placeholder.')
@secure()
param anthropicApiKey string = ''

// ---- Log Analytics ----------------------------------------------------------

@description('Log Analytics workspace name. Receives Container App + APIM logs/metrics.')
param logAnalyticsName string = 'log-infp-clearai-dev-gwc'

@description('Log retention in days (30–730). 30 days is the free retention window.')
@minValue(30)
@maxValue(730)
param logAnalyticsRetentionDays int = 30

@description('Daily ingestion cap in GB. Hard ceiling against runaway log volume.')
param logAnalyticsDailyQuotaGb int = 1

// ---- Container Apps ---------------------------------------------------------

@description('Container Apps Environment name.')
param containerAppsEnvName string = 'cae-infp-clearai-dev-gwc-01'

@description('Container App (backend) name.')
param containerAppName string = 'ca-infp-clearai-be-dev-gwc-01'

@description('Container image (full ref). Public GHCR image, no registry creds.')
param containerImage string = 'ghcr.io/asmadaheripl/clearai-backend:latest'

@description('Foundry endpoint full Target URI including /anthropic/v1/messages. Passed through to the Container App ANTHROPIC_BASE_URL env var.')
param anthropicBaseUrl string = 'https://aif-infp-dev-swc-01.services.ai.azure.com/anthropic/v1/messages'

// ---- APIM -------------------------------------------------------------------

@description('APIM service name. Globally unique.')
param apimName string = 'apim-infp-clearai-be-dev-gwc-01'

@description('APIM publisher email.')
param apimPublisherEmail string = 'asma.said020@gmail.com'

@description('APIM publisher name.')
param apimPublisherName string = 'ClearAI'

// ---- Entra (for APIM validate-jwt policy) -----------------------------------
// Drives the OIDC config URL + audiences/issuers in the inbound API policy.
// Tenant id is your Workforce Entra tenant (the one that owns this Azure
// subscription). The API Application ID URI is the `api://...` value set
// when registering infp-clearai-api-dev-01. The audience can be either the
// app's URI or its client_id (GUID); we accept both.

@description('Entra tenant id (GUID). Workforce tenant that hosts the app registrations.')
param entraTenantId string

@description('Application ID URI for the protected API app registration. e.g. api://infp-clearai-api-dev-01')
param entraApiAppIdUri string = 'api://infp-clearai-api-dev-01'

@description('Application (client) ID GUID for the protected API app registration. Accepted as an alternate audience alongside entraApiAppIdUri.')
param entraApiClientId string = ''

// ---- Network Watcher --------------------------------------------------------

@description('Set true to create a regional Network Watcher in this RG. Set false if NetworkWatcher_germanywestcentral already exists in NetworkWatcherRG (recommended).')
param createNetworkWatcher bool = false

@description('Network Watcher name (only used if createNetworkWatcher = true).')
param networkWatcherName string = 'nw-infp-clearai-dev-gwc-01'

// ---- Storage Account (declaration-run blob artifacts) ----------------------

@description('Storage account name. 3-24 chars, lowercase alphanumeric only, globally unique. Stores ZATCA declaration XML output (HV/LV/manifest) under the declaration-runs container.')
@minLength(3)
@maxLength(24)
param storageAccountName string = 'stinfpclearaidevgwc01'

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
    environmentName: environmentName
    serverName: postgresServerName
    databaseName: postgresDatabaseName
    administratorLogin: postgresAdminLogin
    administratorPassword: postgresAdminPassword
    operatorIpAddress: operatorIpAddress
    appPassword: postgresAppPassword
    migratorPassword: postgresMigratorPassword
    readonlyPassword: postgresReadonlyPassword
    tags: tags
  }
}

// 2. Key Vault (RBAC mode, soft-delete on, env-gated public access + purge protection)
module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault-deploy'
  params: {
    location: location
    environmentName: environmentName
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
    // Phase 2.1: pass through the role-separated conn strings. The
    // postgres module emits empty strings until the corresponding password
    // params are populated, and the keyvault-secrets module gates the
    // resource creation on `!empty(...)` so first-deploy is unaffected.
    postgresAppConnectionString: postgres.outputs.appConnectionString
    postgresMigratorConnectionString: postgres.outputs.migratorConnectionString
    postgresReadonlyConnectionString: postgres.outputs.readonlyConnectionString
  }
}

// 4a. Log Analytics workspace — shared observability sink for the env + APIM.
//     Created BEFORE the Container Apps Environment because the env needs the
//     workspace's customerId + sharedKey at create time (appLogsConfiguration
//     can't be added retroactively without an env update that triggers a
//     revision restart on every app — which we still get on first apply, but
//     not on subsequent deploys).
module logAnalytics 'modules/loganalytics.bicep' = {
  name: 'log-deploy'
  params: {
    location: location
    workspaceName: logAnalyticsName
    retentionInDays: logAnalyticsRetentionDays
    dailyQuotaGb: logAnalyticsDailyQuotaGb
    tags: tags
  }
}

// 4b. Container Apps Environment (Consumption-only) — wired to Log Analytics.
module containerAppsEnv 'modules/containerapps-env.bicep' = {
  name: 'cae-deploy'
  params: {
    location: location
    environmentName: containerAppsEnvName
    logAnalyticsCustomerId: logAnalytics.outputs.customerId
    logAnalyticsSharedKey: logAnalytics.outputs.primarySharedKey
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
    anthropicBaseUrl: anthropicBaseUrl
    useRoleSeparation: useRoleSeparation
    tags: tags
  }
  dependsOn: [
    keyVaultSecrets
  ]
}

// 5b. Storage Account + declaration-runs blob container.
//     Locked down: public network access disabled, shared key access disabled,
//     Entra-only auth via the Container App MI. SPA gets files via short-lived
//     user-delegation SAS URLs minted by the backend, not direct blob reads.
//     Account-scope role grant means RBAC stays simple as containers grow.
module storage 'modules/storage.bicep' = {
  name: 'storage-deploy'
  params: {
    location: location
    environmentName: environmentName
    storageAccountName: storageAccountName
    containerAppPrincipalId: containerApp.outputs.principalId
    tags: tags
  }
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

// 7. APIM Consumption — single instance fronting the Container App.
//    Provisioning takes 10–30 min on first create; idempotent thereafter.
//    Depends on containerApp because we pass its FQDN as the backend URL.
//    The KV-backed named-value is wired in by deploy.sh post-apply (see
//    modules/apim.bicep header comment for why it's not in-template).
module apim 'modules/apim.bicep' = {
  name: 'apim-deploy'
  params: {
    location: location
    apimName: apimName
    publisherName: apimPublisherName
    publisherEmail: apimPublisherEmail
    backendUrl: 'https://${containerApp.outputs.fqdn}'
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    entraTenantId: entraTenantId
    entraApiAppIdUri: entraApiAppIdUri
    entraApiClientId: entraApiClientId
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

output apimName string = apim.outputs.apimName
output apimGatewayUrl string = apim.outputs.gatewayUrl
output apimPrincipalId string = apim.outputs.principalId

output logAnalyticsName string = logAnalytics.outputs.name
output logAnalyticsId string = logAnalytics.outputs.id
output logAnalyticsCustomerId string = logAnalytics.outputs.customerId

output storageAccountName string = storage.outputs.name
output storageBlobEndpoint string = storage.outputs.blobEndpoint
output storageDeclarationRunsContainer string = storage.outputs.declarationRunsContainerName
