// =============================================================================
// Network Watcher (regional singleton)
// =============================================================================
// Azure auto-creates one Network Watcher per region in the NetworkWatcherRG
// resource group when the Microsoft.Network provider is registered. This
// module is a fallback: deploy it ONLY if the auto-created instance is
// missing in the subscription (deploy.sh checks first).
//
// No flow logs are configured in dev.
// =============================================================================

@description('Region.')
param location string

@description('Network Watcher name.')
param networkWatcherName string

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------

resource nw 'Microsoft.Network/networkWatchers@2024-01-01' = {
  name: networkWatcherName
  location: location
  tags: tags
  properties: {}
}

output id string = nw.id
output name string = nw.name
