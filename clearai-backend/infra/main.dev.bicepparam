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

// ---- Log Analytics ----
param logAnalyticsName = 'log-infp-clearai-dev-gwc'
param logAnalyticsRetentionDays = 30
param logAnalyticsDailyQuotaGb = 1

// ---- Container Apps ----
param containerAppsEnvName = 'cae-infp-clearai-dev-gwc-01'
param containerAppName = 'ca-infp-clearai-be-dev-gwc-01'
param containerImage = 'ghcr.io/asmadaheripl/clearai-backend:latest'

// ---- Entra (for APIM validate-jwt) ----
// Apps are registered in the Infinite Apps tenant (NOT the workforce tenant
// that owns this Azure subscription). The Infinite Apps tenant enforces a
// policy that identifier URIs must contain the appId — friendly URIs like
// `api://infp-clearai-api-dev-01` are rejected at create time. So the URI
// is GUID-based here (`api://{api-appId}`) and matches what was actually
// minted by infra/scripts/create-app-regs (run 2026-05-04).
//
// The 4 ClearAI app registrations:
//   ClearAI API DEV  e39436da-d0ff-4923-8971-b4ec10300cfd  (protected resource)
//   ClearAI BFF DEV  e175a327-a139-4dc3-ac5a-92f4966dd057  (confidential client)
//   ClearAI SPA DEV  ca676cec-2861-4ac1-8ebd-cdac36e3e587  (public, browser MSAL)
//   ClearAI CLI DEV  f2ed04f1-2889-440f-a8cb-52fd30ab6411  (public, Postman/CLI)
// API scope id (access_as_user): 3d218216-3348-413b-a305-e9f6ca8285c4
//
// Tenant id below is the Infinite Apps tenant, NOT the subscription's tenant.
// APIM's validate-jwt policy talks to login.microsoftonline.com/{this-tenant}/v2.0
// and accepts tokens issued by that tenant for the audience below.
param entraTenantId    = 'ef324fec-fecc-4c61-af6b-708bc4067e40'
param entraApiAppIdUri = 'api://e39436da-d0ff-4923-8971-b4ec10300cfd'
param entraApiClientId = 'e39436da-d0ff-4923-8971-b4ec10300cfd'

// ---- Network Watcher ----
// Most subs already have NetworkWatcher_germanywestcentral in NetworkWatcherRG.
// deploy.sh detects this and only sets createNetworkWatcher=true if missing.
param createNetworkWatcher = false
param networkWatcherName = 'nw-infp-clearai-dev-gwc-01'

// ---- Storage Account (declaration-run blob artifacts) ----
// Storage account names disallow hyphens, so the convention collapses from
// infp-clearai-dev-gwc to infpclearaidevgwc. 21 chars, under the 24 cap.
param storageAccountName = 'stinfpclearaidevgwc01'

// ---- Tags ----
param tags = {
  app: 'clearai'
  env: 'dev'
  managedBy: 'bicep'
  costCenter: 'clearai'
}
