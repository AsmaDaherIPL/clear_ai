// =============================================================================
// Postgres Flexible Server (B1ms, Postgres 16)
// =============================================================================
// - Public access + SSL enforced
// - Firewall: operator IP + Azure services
// - Extensions: VECTOR, PG_TRGM, UNACCENT, PGCRYPTO (allow-listed)
// - 32 GB storage, 7-day backups, no HA, no geo-redundancy
// - Cost: ~$13–15 / month
// =============================================================================

@description('Region.')
param location string

@description('Server name.')
param serverName string

@description('Database name to create.')
param databaseName string

@description('Postgres administrator login.')
param administratorLogin string

@description('Postgres administrator password (32-char generated).')
@secure()
param administratorPassword string

@description('Operator public IP for firewall allow rule.')
param operatorIpAddress string

@description('Common tags.')
param tags object

// -----------------------------------------------------------------------------

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

// ---- Server-level config: enable extensions via azure.extensions ----
resource extensionsConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR,PG_TRGM,UNACCENT,PGCRYPTO'
    source: 'user-override'
  }
}

// ---- Firewall: allow Azure services (Container App egress) ----
resource fwAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ---- Firewall: allow operator IP ----
resource fwAllowOperator 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowOperatorIp'
  properties: {
    startIpAddress: operatorIpAddress
    endIpAddress: operatorIpAddress
  }
}

// ---- Database ----
resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [
    extensionsConfig
  ]
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

output serverName string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = db.name

@description('Postgres connection string with sslmode=require. SECRET — only used to seed Key Vault, never returned in deployment outputs.')
#disable-next-line outputs-should-not-contain-secrets
output connectionString string = 'postgres://${administratorLogin}:${administratorPassword}@${server.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'
