#!/usr/bin/env bash
# =============================================================================
# ClearAI - Entra app-registration bootstrap
# =============================================================================
# One-shot per environment. Idempotent on re-run.
#
# Creates two app registrations in the Workforce Entra tenant that owns this
# Azure subscription:
#
#   1. infp-clearai-api-dev-01   (the protected API)
#      - Application ID URI:  api://infp-clearai-api-dev-01
#      - Exposes scope:       Classifications.Use  (delegated; user_impersonation-shaped)
#      - Exposes app role:    Classifications.Use  (application; for client-credentials grant)
#      - APIM's validate-jwt policy accepts JWTs whose audience is either
#        the Application ID URI or the client_id GUID.
#
#   2. infp-clearai-web-bff-dev-01  (the SWA-hosted BFF, confidential client)
#      - Has a client_secret that this script mints + stores in Key Vault
#        as `entra-bff-client-secret`. SWA Application Settings reads it via a
#        @Microsoft.KeyVault(...) reference.
#      - Granted application permission `Classifications.Use` on the API app.
#      - Admin consent granted for that permission.
#
# What this script does NOT do:
#   - Configure SWA Application Settings (you do that in the portal once,
#     then `az staticwebapp appsettings set` for ongoing changes).
#   - Configure redirect URIs (none needed — client-credentials grant is
#     non-interactive, no redirect involved).
#   - Create user accounts (no user login at this stage).
#
# Re-run safety:
#   - App registrations: looked up by displayName; created if missing.
#   - Application ID URI: set on first create only.
#   - Scope and app role: created if missing.
#   - Permission grant: idempotent.
#   - Client secret: rotated only when --rotate-secret is passed; otherwise
#     reused from KV. (Rotation invalidates SWA's running BFF until the new
#     secret is propagated and the Function App restarted.)
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

API_APP_NAME="infp-clearai-api-dev-01"
BFF_APP_NAME="infp-clearai-web-bff-dev-01"

# Application ID URI for the API app. Stable logical name (not a GUID), so
# bicep can hard-reference it in apim.bicep.
API_APP_URI="api://infp-clearai-api-dev-01"

# Scope name surfaced in JWTs as `scp` (delegated) or `roles` (app perm).
# Backend can later check this claim to gate which routes a token can call.
API_SCOPE_NAME="Classifications.Use"
API_SCOPE_DESCRIPTION="Use the ClearAI classifications API."

# KV that holds the BFF client_secret.
KV_NAME="kv-infp-clearai-dev-gwc"
KV_SECRET_NAME="entra-bff-client-secret"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\n\033[1;31m[err]\033[0m  %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

ROTATE_SECRET="false"
for arg in "$@"; do
  case "$arg" in
    --rotate-secret) ROTATE_SECRET="true" ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--rotate-secret]

  --rotate-secret   Mint a new BFF client_secret, overwrite the KV secret,
                    and end-date the previous one. SWA Function App must be
                    restarted afterward (`az staticwebapp restart`) so the
                    new secret is picked up. Old tokens already in flight
                    remain valid until natural expiry (~1h).
EOF
      exit 0
      ;;
    *) die "Unknown arg: $arg (try --help)" ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' not found in PATH."
}
require_cmd az
require_cmd python3

# -----------------------------------------------------------------------------
# Tenant context
# -----------------------------------------------------------------------------

TENANT_ID="$(az account show --query tenantId -o tsv)"
[[ -n "$TENANT_ID" ]] || die "Not signed in. Run 'az login' first."
log "Tenant: $TENANT_ID"

# -----------------------------------------------------------------------------
# 1. API app registration
# -----------------------------------------------------------------------------

log "Ensuring API app registration: $API_APP_NAME"
API_APP_ID="$(az ad app list --display-name "$API_APP_NAME" --query '[0].appId' -o tsv 2>/dev/null || true)"

if [[ -z "$API_APP_ID" ]]; then
  echo "  Not found — creating."
  API_APP_ID="$(az ad app create \
    --display-name "$API_APP_NAME" \
    --sign-in-audience AzureADMyOrg \
    --query appId -o tsv)"
  echo "  Created: $API_APP_ID"

  # Set the Application ID URI. Done in a separate `az ad app update` because
  # passing --identifier-uris in `az ad app create` sometimes races with the
  # appId being globally indexed.
  az ad app update --id "$API_APP_ID" --identifier-uris "$API_APP_URI" >/dev/null
  echo "  Application ID URI set: $API_APP_URI"

  # Service principal (the consumable side of the app — required for app
  # role grants to work). Idempotent; create-if-missing.
  az ad sp create --id "$API_APP_ID" >/dev/null 2>&1 || true
else
  echo "  Found: $API_APP_ID"
fi

API_SP_OBJECT_ID="$(az ad sp list --filter "appId eq '$API_APP_ID'" --query '[0].id' -o tsv 2>/dev/null || true)"
if [[ -z "$API_SP_OBJECT_ID" ]]; then
  echo "  Creating service principal for API app"
  API_SP_OBJECT_ID="$(az ad sp create --id "$API_APP_ID" --query id -o tsv)"
fi
echo "  API service principal: $API_SP_OBJECT_ID"

# -----------------------------------------------------------------------------
# 1b. Add Classifications.Use as both a delegated scope AND an app role
# -----------------------------------------------------------------------------
# Why both:
#   - Delegated scope (`oauth2PermissionScopes`) — for any future
#     interactive flow (a user signs in, the SPA acquires a token on
#     their behalf).
#   - App role (`appRoles`) — for the client-credentials flow used by
#     the BFF today. Application permissions are granted via app roles,
#     not delegated scopes; without an app role the BFF's
#     `getToken("api://.../.default")` returns a token with no `roles`
#     claim and APIM's required-claims would reject it (we don't enforce
#     required-claims today, but this future-proofs that gate).
#
# Both carry the same name so the JWT `scp` / `roles` claim is stable.
#
# The az cli doesn't expose these as native arguments — we patch the
# manifest via az rest.

log "Ensuring '$API_SCOPE_NAME' scope and app role on API app"

# Build the desired scope + appRole shape with deterministic GUIDs (hash
# of name) so re-runs don't churn the manifest.
SCOPE_GUID="$(python3 -c "
import hashlib, uuid
h = hashlib.sha1('clearai-classifications-use-scope'.encode()).hexdigest()
print(uuid.UUID(h[:32]))
")"
APPROLE_GUID="$(python3 -c "
import hashlib, uuid
h = hashlib.sha1('clearai-classifications-use-approle'.encode()).hexdigest()
print(uuid.UUID(h[:32]))
")"

# Read current manifest, merge, PATCH back. We only set the fields we own
# (api.oauth2PermissionScopes, appRoles) so unrelated metadata isn't lost.
CURRENT_MANIFEST="$(az rest \
  --method GET \
  --url "https://graph.microsoft.com/v1.0/applications(appId='$API_APP_ID')" \
  --query "{api:api,appRoles:appRoles}" -o json)"

NEW_MANIFEST="$(python3 - <<PY
import json, sys
cur = json.loads('''$CURRENT_MANIFEST''')

scope = {
  "id": "$SCOPE_GUID",
  "type": "User",
  "value": "$API_SCOPE_NAME",
  "userConsentDisplayName": "$API_SCOPE_NAME",
  "userConsentDescription": "$API_SCOPE_DESCRIPTION",
  "adminConsentDisplayName": "$API_SCOPE_NAME",
  "adminConsentDescription": "$API_SCOPE_DESCRIPTION",
  "isEnabled": True,
}
approle = {
  "id": "$APPROLE_GUID",
  "allowedMemberTypes": ["Application"],
  "value": "$API_SCOPE_NAME",
  "displayName": "$API_SCOPE_NAME",
  "description": "$API_SCOPE_DESCRIPTION",
  "isEnabled": True,
}

api = cur.get("api") or {}
scopes = api.get("oauth2PermissionScopes") or []
if not any(s.get("value") == "$API_SCOPE_NAME" for s in scopes):
    scopes.append(scope)
api["oauth2PermissionScopes"] = scopes

roles = cur.get("appRoles") or []
if not any(r.get("value") == "$API_SCOPE_NAME" for r in roles):
    roles.append(approle)

print(json.dumps({"api": api, "appRoles": roles}))
PY
)"

az rest \
  --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications(appId='$API_APP_ID')" \
  --headers "Content-Type=application/json" \
  --body "$NEW_MANIFEST" \
  >/dev/null
echo "  Scope + app role ensured."

# -----------------------------------------------------------------------------
# 2. BFF app registration
# -----------------------------------------------------------------------------

log "Ensuring BFF app registration: $BFF_APP_NAME"
BFF_APP_ID="$(az ad app list --display-name "$BFF_APP_NAME" --query '[0].appId' -o tsv 2>/dev/null || true)"

if [[ -z "$BFF_APP_ID" ]]; then
  echo "  Not found — creating."
  BFF_APP_ID="$(az ad app create \
    --display-name "$BFF_APP_NAME" \
    --sign-in-audience AzureADMyOrg \
    --query appId -o tsv)"
  echo "  Created: $BFF_APP_ID"
  az ad sp create --id "$BFF_APP_ID" >/dev/null 2>&1 || true
else
  echo "  Found: $BFF_APP_ID"
fi

BFF_SP_OBJECT_ID="$(az ad sp list --filter "appId eq '$BFF_APP_ID'" --query '[0].id' -o tsv 2>/dev/null || true)"
if [[ -z "$BFF_SP_OBJECT_ID" ]]; then
  BFF_SP_OBJECT_ID="$(az ad sp create --id "$BFF_APP_ID" --query id -o tsv)"
fi
echo "  BFF service principal: $BFF_SP_OBJECT_ID"

# -----------------------------------------------------------------------------
# 2b. Grant the BFF the Classifications.Use app permission on the API app
# -----------------------------------------------------------------------------

log "Granting BFF 'Classifications.Use' application permission on API app"

# (a) Declare the requiredResourceAccess on the BFF's manifest so the
#     permission is visible in the portal + audit log.
REQUIRED_ACCESS="$(python3 - <<PY
import json
print(json.dumps({
  "requiredResourceAccess": [{
    "resourceAppId": "$API_APP_ID",
    "resourceAccess": [
      {"id": "$APPROLE_GUID", "type": "Role"}
    ]
  }]
}))
PY
)"
az rest \
  --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications(appId='$BFF_APP_ID')" \
  --headers "Content-Type=application/json" \
  --body "$REQUIRED_ACCESS" \
  >/dev/null
echo "  Manifest updated."

# (b) Admin-consent the grant — this is what makes the BFF's tokens
#     actually carry the role claim. Without consent, getToken returns
#     a token with no roles and APIM rejects.
EXISTING_GRANT="$(az rest \
  --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$BFF_SP_OBJECT_ID/appRoleAssignments" \
  --query "value[?appRoleId=='$APPROLE_GUID'].id | [0]" -o tsv 2>/dev/null || true)"

if [[ -z "$EXISTING_GRANT" ]]; then
  az rest \
    --method POST \
    --url "https://graph.microsoft.com/v1.0/servicePrincipals/$BFF_SP_OBJECT_ID/appRoleAssignments" \
    --headers "Content-Type=application/json" \
    --body "{
      \"principalId\": \"$BFF_SP_OBJECT_ID\",
      \"resourceId\": \"$API_SP_OBJECT_ID\",
      \"appRoleId\": \"$APPROLE_GUID\"
    }" \
    >/dev/null
  echo "  Admin consent granted."
else
  echo "  Already granted: $EXISTING_GRANT"
fi

# -----------------------------------------------------------------------------
# 3. BFF client_secret — generate + store in Key Vault
# -----------------------------------------------------------------------------

log "Resolving BFF client_secret"

EXISTING_KV_SECRET="$(az keyvault secret show \
  --vault-name "$KV_NAME" \
  --name "$KV_SECRET_NAME" \
  --query value -o tsv 2>/dev/null || true)"

if [[ "$ROTATE_SECRET" == "true" || -z "$EXISTING_KV_SECRET" ]]; then
  if [[ "$ROTATE_SECRET" == "true" ]]; then
    log "Rotating BFF client_secret"
  else
    log "No existing client_secret in KV — minting one"
  fi

  # Mint with a 12-month validity. The portal default is 24m but Microsoft
  # guidance is "shorter is better"; 12m is the longest we should comfortably
  # use without an automated rotation pipeline.
  NEW_SECRET="$(az ad app credential reset \
    --id "$BFF_APP_ID" \
    --years 1 \
    --display-name "bff-secret-$(date +%Y%m%d)" \
    --query password -o tsv)"

  az keyvault secret set \
    --vault-name "$KV_NAME" \
    --name "$KV_SECRET_NAME" \
    --value "$NEW_SECRET" \
    --query id -o tsv >/dev/null

  echo "  Stored in KV: $KV_NAME/secrets/$KV_SECRET_NAME"
  echo "  ⚠ Restart SWA Function App so the new secret is picked up:"
  echo "    az staticwebapp restart --name <swa-name> --resource-group <rg>"
else
  echo "  Already present in KV — reusing."
fi

# -----------------------------------------------------------------------------
# 4. Print SWA Application Settings to copy
# -----------------------------------------------------------------------------

KV_URI="https://${KV_NAME}.vault.azure.net/secrets/${KV_SECRET_NAME}/"

cat <<EOF

============================================================
ClearAI Entra bootstrap complete.
============================================================
  Tenant id          : $TENANT_ID
  API app reg        : $API_APP_NAME
  API client_id      : $API_APP_ID
  API ID URI         : $API_APP_URI
  API scope/role     : $API_SCOPE_NAME

  BFF app reg        : $BFF_APP_NAME
  BFF client_id      : $BFF_APP_ID
  BFF client_secret  : (in KV: $KV_NAME/$KV_SECRET_NAME)
============================================================

Next steps:

1. Set SWA Application Settings (one-time per env):

   az staticwebapp appsettings set \\
     --name <SWA_NAME> \\
     --resource-group <RG> \\
     --setting-names \\
       APIM_BASE_URL=https://apim-infp-clearai-be-dev-gwc-01.azure-api.net \\
       ENTRA_TENANT_ID=$TENANT_ID \\
       ENTRA_CLIENT_ID=$BFF_APP_ID \\
       ENTRA_CLIENT_SECRET=@Microsoft.KeyVault\\(SecretUri=$KV_URI\\) \\
       ENTRA_API_SCOPE=$API_APP_URI/.default \\
       BFF_MAX_REQUEST_BYTES=262144 \\
       BFF_FORWARD_SUB_KEY=false

   For the Key Vault reference to resolve, the SWA's system-assigned MI
   must have 'Key Vault Secrets User' on the KV.

2. Run the backend deploy (which now reads tenant id + API client_id from
   the live tenant and bakes them into the APIM validate-jwt policy):

   ./infra/deploy.sh

3. Smoke-test the protected API by acquiring a token AS the BFF and
   calling /classifications:

   TOKEN=\$(az account get-access-token \\
     --resource $API_APP_URI \\
     --query accessToken -o tsv)
   curl -sS -X POST \\
     -H "Authorization: Bearer \$TOKEN" \\
     -H "Content-Type: application/json" \\
     -d '{"description":"men white cotton shirt"}' \\
     https://apim-infp-clearai-be-dev-gwc-01.azure-api.net/classifications
EOF
