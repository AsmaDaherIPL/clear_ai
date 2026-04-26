// =============================================================================
// Container Apps Environment (Consumption-only)
// =============================================================================
// - No Log Analytics workspace — appLogsConfiguration is omitted entirely.
//   (The API rejects the string 'none'. Omitting the property == no destination.)
// - No VNet (default networking)
// - Cost: $0 for the env itself; pay only for the apps that run on it
// =============================================================================

@description('Region.')
param location string

@description('Environment name.')
param environmentName string

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
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
