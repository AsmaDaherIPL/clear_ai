// =============================================================================
// Container Apps Environment (Consumption-only)
// =============================================================================
// - Log Analytics destination: every container's stdout/stderr (visible via
//   ContainerAppConsoleLogs_CL) and Azure-side platform events (revision
//   restarts, probe failures — ContainerAppSystemLogs_CL) flow into the
//   workspace passed in via params. Without this the env silently drops logs.
// - No VNet (default networking). Consumption profile only.
// - Cost: $0 for the env itself; pay only for the apps that run on it.
//
// Note on appLogsConfiguration:
//   The env API accepts `destination: 'log-analytics'` plus a workspace
//   customerId + sharedKey. Resource ID alone is not enough. The sharedKey
//   is fetched at deploy time via listKeys() in the calling template.
// =============================================================================

@description('Region.')
param location string

@description('Environment name.')
param environmentName string

@description('Log Analytics workspace customerId (GUID).')
param logAnalyticsCustomerId string

@description('Log Analytics workspace primary shared key.')
@secure()
param logAnalyticsSharedKey string

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

output id string = env.id
output name string = env.name
output defaultDomain string = env.properties.defaultDomain
