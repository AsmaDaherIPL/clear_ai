// =============================================================================
// Log Analytics Workspace (ClearAI shared observability sink)
// =============================================================================
// - SKU: PerGB2018 (pay-as-you-go, the default; first 5 GB/month free).
// - Retention: 30 days. First 31 days are free, so storage cost is $0.
// - Daily ingestion cap: 1 GB/day. Hard ceiling — once hit, ingestion stops
//   for the rest of the UTC day and resumes at midnight. Cheap insurance
//   against runaway log volume from a buggy deploy.
// - Public network access enabled. No private link for dev; revisit for prod.
//
// Consumers (wired in by deploy):
//   - Container Apps Environment via appLogsConfiguration → ContainerApp*
//     log tables (ContainerAppConsoleLogs_CL, ContainerAppSystemLogs_CL).
//   - APIM via diagnosticSettings → ApiManagementGatewayLogs / Metrics.
//
// Cost model (dev, ~0.1–0.5 GB/day expected):
//   ingestion ≤ 5 GB/mo  → $0 (free tier)
//   ingestion > 5 GB/mo  → ~$2.76 / GB
//   retention 30 days     → $0 (within free retention)
// Hard daily cap of 1 GB caps worst-case at ~30 GB/mo ≈ $69 ceiling.
// =============================================================================

@description('Region.')
param location string

@description('Log Analytics workspace name. Must be unique within the resource group.')
param workspaceName string

@description('Retention in days (30–730). 30 is within the free retention window.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

@description('Daily ingestion cap in GB. -1 disables the cap. Default 1 GB/day for dev.')
param dailyQuotaGb int = 1

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    features: {
      // Disable legacy access modes; use AAD/RBAC only.
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------
// customerId + sharedKey are required by the Container Apps Environment's
// appLogsConfiguration (it doesn't accept the workspace resource ID alone).
// id is the resource ID, used for diagnosticSettings (APIM).
//
// listKeys() is a runtime function — Bicep emits it as a deployment-time
// reference. Outputs marked @secure() suppress the value from deploy logs.

output id string = workspace.id
output name string = workspace.name
output customerId string = workspace.properties.customerId

@secure()
output primarySharedKey string = workspace.listKeys().primarySharedKey
