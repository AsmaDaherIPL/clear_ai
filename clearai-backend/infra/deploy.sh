#!/usr/bin/env bash
# =============================================================================
# ClearAI - Dev Deploy Script
# =============================================================================
# Idempotent wrapper around `az deployment group create` plus the bits
# Bicep cannot do cleanly:
#   1. Detect operator public IP for Postgres firewall
#   2. Resource provider registration check
#   3. Pre-flight: ensure Key Vault name is globally available (no auto-suffix)
#   4. Pre-flight: detect existing regional Network Watcher
#   5. Generate a 32-char Postgres admin password (only on first deploy;
#      reused from KV on subsequent runs)
#   5b. Generate a 48-char URL-safe APIM shared secret (only on first deploy;
#       reused from KV on subsequent runs)
#   6. Run the Bicep deployment
#   7. Assign Container App MI -> 'Key Vault Secrets User' on the KV
#   7b. Assign APIM MI -> 'Key Vault Secrets User' on the KV (so the
#       KV-backed named-value `apim-shared-secret` resolves)
#   8. Trigger one revision restart so secretrefs resolve
#   9. Print outputs (no secrets)
#
# Re-runs are safe. Existing resources update in place.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Config (matches main.dev.bicepparam — change here AND there if renaming)
# -----------------------------------------------------------------------------

SUBSCRIPTION_ID="6e9d19dc-d200-4be3-810f-cc4e920608c8"   # sub-infp-clearai-nonprod-gwc
RESOURCE_GROUP="rg-infp-clearai-common-dev-gwc-01"
LOCATION="germanywestcentral"

KV_NAME="kv-infp-clearai-dev-gwc"
PG_SERVER_NAME="psql-infp-clearai-dev-gwc-01"
CA_NAME="ca-infp-clearai-be-dev-gwc-01"

PARAM_FILE="$(cd "$(dirname "$0")" && pwd)/main.dev.bicepparam"
TEMPLATE_FILE="$(cd "$(dirname "$0")" && pwd)/main.bicep"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\n\033[1;31m[err]\033[0m  %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' not found in PATH."
}

# -----------------------------------------------------------------------------
# 0. Prerequisites
# -----------------------------------------------------------------------------

require_cmd az
require_cmd curl
require_cmd python3   # only used for url-encoding the password

log "Setting active subscription"
az account set --subscription "$SUBSCRIPTION_ID"
ACCT="$(az account show --query '{name:name, id:id, tenant:tenantId}' -o json)"
echo "$ACCT"

log "Checking resource group exists"
az group show --name "$RESOURCE_GROUP" >/dev/null \
  || die "Resource group '$RESOURCE_GROUP' not found. Ask the platform team."

# -----------------------------------------------------------------------------
# 1. Resource provider registration
# -----------------------------------------------------------------------------

log "Checking required resource providers"
REQUIRED_RPS=(
  Microsoft.App
  Microsoft.OperationalInsights
  Microsoft.KeyVault
  Microsoft.DBforPostgreSQL
  Microsoft.Network
)

for rp in "${REQUIRED_RPS[@]}"; do
  state="$(az provider show --namespace "$rp" --query registrationState -o tsv 2>/dev/null || echo NotRegistered)"
  if [[ "$state" != "Registered" ]]; then
    log "Registering provider $rp (current: $state)"
    az provider register --namespace "$rp" --wait
  else
    echo "  $rp: Registered"
  fi
done

# -----------------------------------------------------------------------------
# 2. Key Vault name availability (no auto-suffix — fail clearly)
# -----------------------------------------------------------------------------

log "Checking Key Vault name availability: $KV_NAME"
EXISTING_KV_ID="$(az keyvault show --name "$KV_NAME" --resource-group "$RESOURCE_GROUP" \
  --query id -o tsv 2>/dev/null || true)"

if [[ -n "$EXISTING_KV_ID" ]]; then
  echo "  Key Vault already exists in this RG — re-using."
else
  AVAIL_JSON="$(az keyvault check-name --name "$KV_NAME" -o json 2>/dev/null || echo '{}')"
  AVAIL="$(echo "$AVAIL_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("nameAvailable", False))' 2>/dev/null || echo False)"
  REASON="$(echo "$AVAIL_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("reason", "Unknown"))' 2>/dev/null || echo Unknown)"
  if [[ "$AVAIL" != "True" ]]; then
    die "Key Vault name '$KV_NAME' is not available globally (reason: $REASON).
Edit main.dev.bicepparam (and deploy.sh KV_NAME) in this folder and pick another name <=24 chars.
No auto-suffix is applied — this is intentional so the name stays predictable."
  fi
  echo "  Available."
fi

# -----------------------------------------------------------------------------
# 3. Network Watcher presence
# -----------------------------------------------------------------------------

log "Checking for regional Network Watcher in NetworkWatcherRG"
NW_EXISTS="$(az network watcher list --query "[?location=='$LOCATION'] | [0].id" -o tsv 2>/dev/null || true)"

if [[ -n "$NW_EXISTS" ]]; then
  echo "  Found existing Network Watcher: $NW_EXISTS"
  CREATE_NW="false"
else
  warn "No regional Network Watcher found. Will create one in $RESOURCE_GROUP."
  CREATE_NW="true"
fi

# -----------------------------------------------------------------------------
# 4. Operator IP (for Postgres firewall)
# -----------------------------------------------------------------------------

log "Detecting operator public IP"
OPERATOR_IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
[[ -n "$OPERATOR_IP" ]] || die "Could not detect operator IP via api.ipify.org."
echo "  $OPERATOR_IP"

# -----------------------------------------------------------------------------
# 5. Postgres admin password (generate once, then reuse from KV)
# -----------------------------------------------------------------------------

PG_PASSWORD=""

if [[ -n "$EXISTING_KV_ID" ]]; then
  log "Trying to read existing postgres-password from Key Vault"
  PG_PASSWORD="$(az keyvault secret show \
    --vault-name "$KV_NAME" \
    --name postgres-password \
    --query value -o tsv 2>/dev/null || true)"
fi

if [[ -z "$PG_PASSWORD" ]]; then
  log "Generating new 32-char Postgres admin password"
  # 32 chars, alnum + a few symbols Postgres tolerates (no shell-hostile chars)
  PG_PASSWORD="$(python3 -c '
import secrets, string
alphabet = string.ascii_letters + string.digits + "-_~."
print("".join(secrets.choice(alphabet) for _ in range(32)))
')"
fi

# url-encode for the connection string (used inside Bicep)
PG_PASSWORD_URLENC="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$PG_PASSWORD")"

# -----------------------------------------------------------------------------
# Anthropic key resolution (precedence: shell env > existing KV > placeholder)
# -----------------------------------------------------------------------------
# The previous one-liner — `ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-__REPLACE__}"` —
# silently overwrote a real key in KV with the placeholder whenever the operator
# forgot to `export ANTHROPIC_API_KEY` in their shell. Because Container App
# secretref binds KV secret values at REVISION CREATION TIME (not at restart),
# a single re-deploy could break LLM calls without any warning beyond the
# summary line at the end of the script.
#
# New behaviour:
#   1. If the shell exported ANTHROPIC_API_KEY, use that. (Operator intent —
#      e.g. rotating the key, or first deploy ever.)
#   2. Otherwise, if KV already holds a real (non-placeholder, non-empty)
#      value, reuse it. The bicep deploy will pass the same value back into
#      the keyvault-secrets module, so the secret is unchanged in practice.
#   3. Otherwise, fall back to '__REPLACE__'. This is only the first-deploy
#      case (KV doesn't exist yet OR was wiped).
#
# Same rationale and shape as the apim-shared-secret block below — keeping
# them parallel so a future hand-rotation script knows where to look.

ANTHROPIC_KEY_SOURCE="placeholder"

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  ANTHROPIC_KEY="$ANTHROPIC_API_KEY"
  ANTHROPIC_KEY_SOURCE="shell"
elif [[ -n "$EXISTING_KV_ID" ]]; then
  # KV exists from a prior deploy — see if it has a real value to preserve.
  EXISTING_ANTHROPIC_KEY="$(az keyvault secret show \
    --vault-name "$KV_NAME" \
    --name anthropic-api-key \
    --query value -o tsv 2>/dev/null || true)"
  if [[ -n "$EXISTING_ANTHROPIC_KEY" && "$EXISTING_ANTHROPIC_KEY" != "__REPLACE__" ]]; then
    ANTHROPIC_KEY="$EXISTING_ANTHROPIC_KEY"
    ANTHROPIC_KEY_SOURCE="kv"
  else
    ANTHROPIC_KEY="__REPLACE__"
  fi
else
  ANTHROPIC_KEY="__REPLACE__"
fi

case "$ANTHROPIC_KEY_SOURCE" in
  shell)       log "Anthropic key: using value from shell env (will be written to KV)" ;;
  kv)          log "Anthropic key: reusing existing real value from Key Vault (no overwrite)" ;;
  placeholder) warn "Anthropic key: no shell env and no real KV value — seeding '__REPLACE__'. LLM calls will fail until you set a real key (see summary at end)." ;;
esac

# -----------------------------------------------------------------------------
# 5b. APIM shared secret (generate once, reuse from KV)
# -----------------------------------------------------------------------------
# Independent of the bicep deploy because:
#   - The named-value in apim.bicep references this KV secret BY URI.
#     If it doesn't exist when APIM resolves the named-value, the named-value
#     enters a permanent error state and we'd need a follow-up re-link.
#   - Rotating it later is just `az keyvault secret set` followed by APIM's
#     auto-refresh (or a refreshSecret call), so this stays idempotent.

if [[ -n "$EXISTING_KV_ID" ]]; then
  log "Checking for existing apim-shared-secret in Key Vault"
  EXISTING_APIM_SECRET="$(az keyvault secret show \
    --vault-name "$KV_NAME" \
    --name apim-shared-secret \
    --query value -o tsv 2>/dev/null || true)"

  if [[ -z "$EXISTING_APIM_SECRET" ]]; then
    log "Generating new 48-char URL-safe APIM shared secret"
    NEW_APIM_SECRET="$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=')"
    az keyvault secret set \
      --vault-name "$KV_NAME" \
      --name apim-shared-secret \
      --value "$NEW_APIM_SECRET" \
      --query id -o tsv >/dev/null
    echo "  Stored in KV (length: ${#NEW_APIM_SECRET})."
  else
    echo "  Already present (length: ${#EXISTING_APIM_SECRET})."
  fi
fi

# -----------------------------------------------------------------------------
# 6. Bicep deployment
# -----------------------------------------------------------------------------

DEPLOY_NAME="clearai-dev-$(date +%Y%m%d-%H%M%S)"

log "Running Bicep deployment: $DEPLOY_NAME"

# Bicep builds the connection string from administratorPassword + login + fqdn,
# so we must pass the URL-encoded password as administratorPassword if we want
# the conn string to be valid. But the server itself wants the RAW password.
# Workaround: we pass the RAW password to administratorPassword, and we let
# Bicep build the conn string with it. The chars in our alphabet are URL-safe
# (-_~.) so encoding == raw. Postgres also accepts these in the userinfo part.
# (If you change the alphabet, re-verify URL-safety here.)

az deployment group create \
  --name "$DEPLOY_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_FILE" \
  --parameters "$PARAM_FILE" \
  --parameters \
      postgresAdminPassword="$PG_PASSWORD" \
      operatorIpAddress="$OPERATOR_IP" \
      anthropicApiKey="$ANTHROPIC_KEY" \
      createNetworkWatcher="$CREATE_NW" \
  --output json \
  > /tmp/clearai-deploy-output.json

echo "  Deployment OK. Outputs saved to /tmp/clearai-deploy-output.json"

# -----------------------------------------------------------------------------
# 7. Outputs
# -----------------------------------------------------------------------------

CA_PRINCIPAL_ID="$(python3 -c '
import json,sys
d=json.load(open("/tmp/clearai-deploy-output.json"))
print(d["properties"]["outputs"]["containerAppPrincipalId"]["value"])
')"
APIM_PRINCIPAL_ID="$(python3 -c '
import json,sys
d=json.load(open("/tmp/clearai-deploy-output.json"))
print(d["properties"]["outputs"].get("apimPrincipalId", {}).get("value", ""))
')"
APIM_NAME="$(python3 -c '
import json,sys
d=json.load(open("/tmp/clearai-deploy-output.json"))
print(d["properties"]["outputs"].get("apimName", {}).get("value", ""))
')"
APIM_GATEWAY_URL="$(python3 -c '
import json,sys
d=json.load(open("/tmp/clearai-deploy-output.json"))
print(d["properties"]["outputs"].get("apimGatewayUrl", {}).get("value", ""))
')"
KV_ID="$(az keyvault show --name "$KV_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)"
PG_FQDN="$(python3 -c '
import json
d=json.load(open("/tmp/clearai-deploy-output.json"))
print(d["properties"]["outputs"]["postgresFqdn"]["value"])
')"
CA_FQDN="$(python3 -c '
import json
d=json.load(open("/tmp/clearai-deploy-output.json"))
print(d["properties"]["outputs"]["containerAppFqdn"]["value"])
')"

# -----------------------------------------------------------------------------
# 8. Role assignment: Container App MI -> Key Vault Secrets User
# -----------------------------------------------------------------------------

# Role: Key Vault Secrets User
KV_SECRETS_USER_ROLE_ID="4633458b-17de-408a-b874-0445c86b69e6"

log "Assigning 'Key Vault Secrets User' to Container App MI"
# Idempotent: if it already exists, az exits non-zero — we ignore.
if az role assignment list \
      --assignee-object-id "$CA_PRINCIPAL_ID" \
      --scope "$KV_ID" \
      --role "$KV_SECRETS_USER_ROLE_ID" \
      --query '[0].id' -o tsv 2>/dev/null | grep -q .; then
  echo "  Already assigned."
else
  az role assignment create \
    --assignee-object-id "$CA_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$KV_SECRETS_USER_ROLE_ID" \
    --scope "$KV_ID" \
    >/dev/null
  echo "  Created. Waiting 30s for AAD propagation..."
  sleep 30
fi

# Same role, but for the APIM service's system-assigned MI. APIM needs it
# to resolve the KV-backed named-value `apim-shared-secret` at policy-eval
# time. Without this the named-value stays at its bootstrap placeholder and
# every request through the gateway gets the wrong header (the backend then
# 401s, which is exactly what the origin lock is supposed to do — so it's
# actually safe-fail, but the gateway is non-functional until we fix it).
if [[ -n "$APIM_PRINCIPAL_ID" ]]; then
  log "Assigning 'Key Vault Secrets User' to APIM MI"
  if az role assignment list \
        --assignee-object-id "$APIM_PRINCIPAL_ID" \
        --scope "$KV_ID" \
        --role "$KV_SECRETS_USER_ROLE_ID" \
        --query '[0].id' -o tsv 2>/dev/null | grep -q .; then
    echo "  Already assigned."
  else
    az role assignment create \
      --assignee-object-id "$APIM_PRINCIPAL_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$KV_SECRETS_USER_ROLE_ID" \
      --scope "$KV_ID" \
      >/dev/null
    echo "  Created. Waiting 30s for AAD propagation..."
    sleep 30
  fi

  # Flip the named-value from its bicep-time bootstrap placeholder to a
  # KV-backed binding. Idempotent: re-running just rewrites to the same
  # KV secret URI. We hit the ARM REST API directly because `az apim nv
  # update` doesn't expose --key-vault-secret-id on all CLI versions.
  if [[ -n "$APIM_NAME" ]]; then
    log "Flipping APIM named-value 'apim-shared-secret' to KV-backed"
    KV_SECRET_URI="$(az keyvault secret show \
      --vault-name "$KV_NAME" \
      --name apim-shared-secret \
      --query id -o tsv)"
    # `id` returns the versioned URI; APIM accepts either versioned or
    # unversioned. Use the unversioned form so secret rotation flows through
    # automatically without forcing an apim refresh.
    KV_SECRET_URI_NV="${KV_SECRET_URI%/*}"

    az rest \
      --method PATCH \
      --url "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ApiManagement/service/$APIM_NAME/namedValues/apim-shared-secret?api-version=2024-05-01" \
      --headers "Content-Type=application/json" \
      --body "{
        \"properties\": {
          \"displayName\": \"apim-shared-secret\",
          \"secret\": true,
          \"keyVault\": {
            \"secretIdentifier\": \"$KV_SECRET_URI_NV\"
          }
        }
      }" \
      >/dev/null
    echo "  Bound to KV secret: $KV_SECRET_URI_NV"
  fi
fi

# -----------------------------------------------------------------------------
# 8b. APIM subscription key (idempotent — create or fetch)
# -----------------------------------------------------------------------------
# A subscription scoped to the `clearai` product. Display key is fetched on
# demand so it stays out of any deployment state files.
if [[ -n "$APIM_NAME" ]]; then
  log "Ensuring APIM subscription 'clearai-default' under product 'clearai'"
  SUB_SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ApiManagement/service/$APIM_NAME/products/clearai"
  if ! az apim api show >/dev/null 2>&1 \
       --resource-group "$RESOURCE_GROUP" \
       --service-name "$APIM_NAME" \
       --api-id clearai-backend; then
    warn "Protected API 'clearai-backend' not visible yet — subscription create may fail. Retry deploy.sh in a minute."
  fi
  az rest \
    --method PUT \
    --url "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ApiManagement/service/$APIM_NAME/subscriptions/clearai-default?api-version=2024-05-01" \
    --headers "Content-Type=application/json" \
    --body "{
      \"properties\": {
        \"displayName\": \"ClearAI default subscription\",
        \"scope\": \"$SUB_SCOPE\",
        \"state\": \"active\"
      }
    }" \
    >/dev/null

  APIM_SUB_KEY="$(az rest \
    --method POST \
    --url "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ApiManagement/service/$APIM_NAME/subscriptions/clearai-default/listSecrets?api-version=2024-05-01" \
    --query primaryKey -o tsv)"
fi

# -----------------------------------------------------------------------------
# 9. Trigger a single revision restart so secretrefs resolve
# -----------------------------------------------------------------------------

log "Triggering Container App revision restart"
LATEST_REV="$(az containerapp revision list \
  --name "$CA_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query '[0].name' -o tsv 2>/dev/null || true)"

if [[ -n "$LATEST_REV" ]]; then
  az containerapp revision restart \
    --name "$CA_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --revision "$LATEST_REV" >/dev/null || warn "Revision restart failed; cold start will pick up secrets."
  echo "  Restarted revision: $LATEST_REV"
else
  warn "No revision found yet — first cold start will pick up secrets."
fi

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------

cat <<EOF

============================================================
ClearAI dev deploy complete.
============================================================
  Resource group : $RESOURCE_GROUP
  Region         : $LOCATION

  Postgres FQDN  : $PG_FQDN
  Postgres DB    : clearai
  Postgres user  : clearai_admin
  Password       : (stored in Key Vault as 'postgres-password')

  Key Vault      : $KV_NAME
  Anthropic key  : $(
    case "$ANTHROPIC_KEY_SOURCE" in
      shell)       echo "set (from shell env this run)" ;;
      kv)          echo "set (preserved from Key Vault — not overwritten)" ;;
      placeholder) echo "PLACEHOLDER — update with: az keyvault secret set --vault-name $KV_NAME --name anthropic-api-key --value <REAL_KEY>" ;;
    esac
  )

  Container App  : $CA_NAME
  App URL        : https://$CA_FQDN  (origin — locked to APIM-only)
  Health check   : https://$CA_FQDN/health  (always anonymous)

  APIM           : ${APIM_NAME:-not-deployed}
  Gateway URL    : ${APIM_GATEWAY_URL:-pending}
  Subscription   : clearai-default (product: clearai)
  Sub Key        : ${APIM_SUB_KEY:-not-yet-minted}
============================================================

Next steps:
  1. If you saw the placeholder warning above, set the real Anthropic key.
  2. Once Foundry models are renamed, set ANTHROPIC_BASE_URL / LLM_MODEL /
     LLM_MODEL_STRONG via:
        az containerapp update --name $CA_NAME --resource-group $RESOURCE_GROUP \\
          --set-env-vars LLM_MODEL=<name> LLM_MODEL_STRONG=<name> \\
                         ANTHROPIC_BASE_URL=<url>
  3. Curl the health endpoint to verify:
        curl -fsS https://$CA_FQDN/health
EOF
