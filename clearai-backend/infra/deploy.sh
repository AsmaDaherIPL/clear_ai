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
#   6. Read Entra app-reg metadata (tenant id, API app client_id) — fail
#      loudly if `infp-clearai-api-dev-01` doesn't exist yet (operator
#      must run bootstrap-entra.sh first; see that script's comments)
#   7. Run the Bicep deployment
#   8. Assign Container App MI -> 'Key Vault Secrets User' on the KV
#   8b. Assign APIM MI -> 'Key Vault Secrets User' on the KV (so the
#       KV-backed named-value `apim-shared-secret` resolves)
#   9. Trigger one revision restart so secretrefs resolve
#  10. Print outputs (no secrets)
#
# Re-runs are safe. Existing resources update in place.
#
# OPTION A CUTOVER NOTE (2026-05-01, see docs/SECURITY-REMEDIATION-PLAN.md §1):
# The previous "mint an APIM subscription key" step is GONE. APIM no longer
# requires subscription keys — auth is via Entra-issued JWT validated by the
# `validate-jwt` policy in apim.bicep. The frontend BFF (SWA Function in
# clearai-frontend/api/) holds the Entra client_secret server-side and never
# leaks it to the browser. C1 / H1 fixed.
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
# 5c. Phase 2.1 — role-separated DB credentials
# -----------------------------------------------------------------------------
# The role-creation SQL (drizzle/0019_role_separation.sql) creates three
# logins WITHOUT passwords. Passwords MUST be set out-of-band so they don't
# end up in version control. We:
#   1. Look up an existing password for each role in KV; generate if missing.
#   2. Pass the passwords into the bicep deploy as @secure() params; the
#      postgres + keyvault-secrets modules emit/store the connection strings.
#   3. After the deploy, run `ALTER ROLE ... PASSWORD ...` against the DB
#      via the admin connection so the live Postgres login matches what we
#      stored in KV. (Step 5d below.)
#
# Cutover gate (USE_ROLE_SEPARATION):
#   First deploy after 0019_role_separation.sql lands: leave at 'false' so
#   the Container App keeps using the admin conn string while the new roles
#   are created and passwords are set. Once `psql` smoke-test confirms the
#   new logins work, set USE_ROLE_SEPARATION=true and re-run deploy.sh —
#   that flips the env var split (DATABASE_URL -> app, MIGRATOR_DATABASE_URL
#   -> migrator) and triggers a Container App revision restart.

USE_ROLE_SEPARATION="${USE_ROLE_SEPARATION:-false}"
log "Role separation flag: USE_ROLE_SEPARATION=$USE_ROLE_SEPARATION"

mint_role_password() {
  local kv_secret_name="$1"
  local existing
  existing="$(az keyvault secret show \
    --vault-name "$KV_NAME" \
    --name "$kv_secret_name" \
    --query value -o tsv 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    echo "$existing"
    return
  fi
  # Same alphabet as PG_PASSWORD: alnum + URL-safe punctuation.
  python3 -c '
import secrets, string
alphabet = string.ascii_letters + string.digits + "-_~."
print("".join(secrets.choice(alphabet) for _ in range(32)))
'
}

if [[ -n "$EXISTING_KV_ID" ]]; then
  log "Resolving role passwords (clearai_app / clearai_migrator / clearai_readonly)"
  PG_APP_PASSWORD="$(mint_role_password 'postgres-app-password')"
  PG_MIGRATOR_PASSWORD="$(mint_role_password 'postgres-migrator-password')"
  PG_READONLY_PASSWORD="$(mint_role_password 'postgres-readonly-password')"

  # Persist each password under a dedicated KV secret. These are SEPARATE
  # from the connection-string secrets (which the bicep keyvault-secrets
  # module writes); having both lets us rotate just the password and
  # recompute the conn string without touching bicep.
  for pair in \
    "postgres-app-password:$PG_APP_PASSWORD" \
    "postgres-migrator-password:$PG_MIGRATOR_PASSWORD" \
    "postgres-readonly-password:$PG_READONLY_PASSWORD"; do
    name="${pair%%:*}"
    value="${pair#*:}"
    az keyvault secret set \
      --vault-name "$KV_NAME" --name "$name" --value "$value" \
      --query id -o tsv >/dev/null
  done
  echo "  Three role passwords stored in KV (32 chars each)."
else
  PG_APP_PASSWORD=""
  PG_MIGRATOR_PASSWORD=""
  PG_READONLY_PASSWORD=""
  warn "Skipping role-password generation — KV not yet created (first deploy)."
fi

# -----------------------------------------------------------------------------
# 6. Entra app-registration metadata (for APIM validate-jwt policy)
# -----------------------------------------------------------------------------
# UPDATED 2026-05-04: app registrations now live in the *Infinite Apps* tenant
# (ef324fec-...) — separate from the workforce tenant that owns this Azure
# subscription (4efdd8aa-...). The 4 apps were created manually via the
# session script (see main.dev.bicepparam Entra block for the GUIDs).
#
# As a result deploy.sh no longer auto-detects ENTRA_TENANT_ID from
# `az account show` (that returns the workforce tenant, which is the wrong
# answer). Instead the values come from main.dev.bicepparam directly — Bicep
# already declares them as params with concrete values.
#
# Override behaviour:
#   - If env vars ENTRA_TENANT_ID / ENTRA_API_CLIENT_ID are set in the shell
#     they win (allows ad-hoc deploys against a different app reg).
#   - Otherwise the values from main.dev.bicepparam are used as-is (we don't
#     pass --parameters overrides for them on the az command line).
#
# SKIP_ENTRA_CHECK=true is preserved for the partial-deploy escape hatch.

SKIP_ENTRA_CHECK="${SKIP_ENTRA_CHECK:-false}"

log "Resolving Entra metadata"
if [[ -n "${ENTRA_TENANT_ID:-}" && -n "${ENTRA_API_CLIENT_ID:-}" ]]; then
  echo "  Using ENTRA_TENANT_ID + ENTRA_API_CLIENT_ID from shell env (override mode)."
  ENTRA_OVERRIDE="true"
elif [[ "$SKIP_ENTRA_CHECK" == "true" ]]; then
  warn "SKIP_ENTRA_CHECK=true — passing placeholder values; APIM will reject all JWTs."
  ENTRA_TENANT_ID="00000000-0000-0000-0000-000000000000"
  ENTRA_API_CLIENT_ID="00000000-0000-0000-0000-000000000000"
  ENTRA_OVERRIDE="true"
else
  echo "  Using values from main.dev.bicepparam (no shell override)."
  ENTRA_OVERRIDE="false"
fi
[[ "$ENTRA_OVERRIDE" == "true" ]] && echo "  Tenant override: $ENTRA_TENANT_ID  /  API client override: $ENTRA_API_CLIENT_ID"

# -----------------------------------------------------------------------------
# 7. Bicep deployment
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

# Build optional Entra param overrides only if shell env or SKIP_ENTRA_CHECK
# set them. Otherwise the bicepparam file's values are used unchanged.
ENTRA_OVERRIDE_ARGS=()
if [[ "${ENTRA_OVERRIDE:-false}" == "true" ]]; then
  ENTRA_OVERRIDE_ARGS+=( "entraTenantId=$ENTRA_TENANT_ID" "entraApiClientId=$ENTRA_API_CLIENT_ID" )
fi

az deployment group create \
  --name "$DEPLOY_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE_FILE" \
  --parameters "$PARAM_FILE" \
  --parameters \
      postgresAdminPassword="$PG_PASSWORD" \
      postgresAppPassword="$PG_APP_PASSWORD" \
      postgresMigratorPassword="$PG_MIGRATOR_PASSWORD" \
      postgresReadonlyPassword="$PG_READONLY_PASSWORD" \
      useRoleSeparation="$USE_ROLE_SEPARATION" \
      operatorIpAddress="$OPERATOR_IP" \
      anthropicApiKey="$ANTHROPIC_KEY" \
      createNetworkWatcher="$CREATE_NW" \
      ${ENTRA_OVERRIDE_ARGS[@]+"${ENTRA_OVERRIDE_ARGS[@]}"} \
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
# 8c. Phase 2.1 — set passwords on the live Postgres roles
# -----------------------------------------------------------------------------
# The role-creation migration (0019_role_separation.sql) creates the roles
# WITHOUT passwords. We set them out-of-band here via the admin connection:
#
#   ALTER ROLE clearai_app PASSWORD '<minted>';
#   ALTER ROLE clearai_migrator PASSWORD '<minted>';
#   ALTER ROLE clearai_readonly PASSWORD '<minted>';
#
# Idempotent: re-running with the same password is a no-op from the
# application's perspective (the existing connection-string in KV stays
# valid). If `mint_role_password` generated a new one, that new password
# is what we set, AND the new conn string secrets in KV reflect it.
#
# Sequencing note: this step is a no-op on the FIRST deploy that adds
# 0019_role_separation.sql, because the migration only runs when the
# Container App restarts (step 9), AFTER this step. The IF EXISTS guard
# means we silently skip; on the second deploy the roles exist and the
# ALTER ROLE applies cleanly. Two deploys to fully cut over — documented
# as the expected sequence.
#
# We use `az postgres flexible-server execute` (no `psql` binary needed
# locally). It connects via the public network from your operator IP —
# already allow-listed by the Postgres firewall rule.

if [[ -n "$PG_APP_PASSWORD" && -n "$PG_MIGRATOR_PASSWORD" && -n "$PG_READONLY_PASSWORD" ]]; then
  log "Setting passwords on the three role-separated Postgres logins"
  PG_DB_NAME="clearai"

  # The DO block is robust to roles not yet existing — emits a NOTICE
  # rather than ERROR so the deploy doesn't abort during the first-deploy
  # window before 0019_role_separation.sql has applied.
  ROLE_PW_SQL=$(cat <<EOF
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_app') THEN
    EXECUTE format('ALTER ROLE clearai_app PASSWORD %L', '$PG_APP_PASSWORD');
    RAISE NOTICE 'clearai_app password set';
  ELSE
    RAISE NOTICE 'clearai_app role missing — run migrations first';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_migrator') THEN
    EXECUTE format('ALTER ROLE clearai_migrator PASSWORD %L', '$PG_MIGRATOR_PASSWORD');
    RAISE NOTICE 'clearai_migrator password set';
  ELSE
    RAISE NOTICE 'clearai_migrator role missing — run migrations first';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_readonly') THEN
    EXECUTE format('ALTER ROLE clearai_readonly PASSWORD %L', '$PG_READONLY_PASSWORD');
    RAISE NOTICE 'clearai_readonly password set';
  ELSE
    RAISE NOTICE 'clearai_readonly role missing — run migrations first';
  END IF;
END
\$\$;
EOF
)

  if az postgres flexible-server execute \
        --name "$PG_SERVER_NAME" \
        --admin-user clearai_admin \
        --admin-password "$PG_PASSWORD" \
        --database-name "$PG_DB_NAME" \
        --querytext "$ROLE_PW_SQL" \
        --output none 2>&1; then
    echo "  Role passwords applied (or no-op'd if roles not yet created)."
  else
    warn "ALTER ROLE step failed — likely the migration hasn't run yet. Re-run deploy.sh after the next Container App revision applies 0019_role_separation.sql."
  fi
fi

# -----------------------------------------------------------------------------
# 8b. (RETIRED) APIM subscription key mint
# -----------------------------------------------------------------------------
# Removed in the Option A cutover (frontend security review C1):
#   - The protected API now has subscriptionRequired: false
#   - Auth is via Entra-issued JWT validated by APIM's validate-jwt policy
#   - The frontend BFF holds an Entra client_secret server-side, exchanges
#     it for an access token, and forwards. The browser bundle ships zero
#     credentials.
#
# If you need to roll back to subscription-key auth as a fallback:
#   1. Set subscriptionRequired: true on apiProtected in apim.bicep
#   2. Drop the validate-jwt block from apiInboundPolicyXml
#   3. Re-add the mint step here (preserved in git history at the previous
#      commit on this file)
APIM_SUB_KEY=""

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

# Build the Anthropic-key status line up-front. A `$(case ... esac)` directly
# inside the heredoc below would let the heredoc parser swallow the `;;`
# terminators as if they were literal text — bash 3.2 (macOS default) chokes
# on it. Resolving to a plain variable is portable and obvious.
case "$ANTHROPIC_KEY_SOURCE" in
  shell)       ANTHROPIC_KEY_STATUS_MSG="set (from shell env this run)" ;;
  kv)          ANTHROPIC_KEY_STATUS_MSG="set (preserved from Key Vault — not overwritten)" ;;
  placeholder) ANTHROPIC_KEY_STATUS_MSG="PLACEHOLDER — update with: az keyvault secret set --vault-name $KV_NAME --name anthropic-api-key --value <REAL_KEY>" ;;
esac

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
  Anthropic key  : $ANTHROPIC_KEY_STATUS_MSG

  Container App  : $CA_NAME
  App URL        : https://$CA_FQDN  (origin — locked to APIM-only)
  Health check   : https://$CA_FQDN/health  (always anonymous)

  APIM           : ${APIM_NAME:-not-deployed}
  Gateway URL    : ${APIM_GATEWAY_URL:-pending}
  Auth model     : Entra JWT (validate-jwt). NO subscription key.
  Tenant id      : ${ENTRA_TENANT_ID:-(from main.dev.bicepparam)}
  API app        : ${ENTRA_API_CLIENT_ID:-(from main.dev.bicepparam)}
============================================================

Next steps:
  1. If you saw the placeholder warning above, set the real Anthropic key.
  2. Once Foundry models are renamed, set ANTHROPIC_BASE_URL / LLM_MODEL /
     LLM_MODEL_STRONG via:
        az containerapp update --name $CA_NAME --resource-group $RESOURCE_GROUP \\
          --set-env-vars LLM_MODEL=<name> LLM_MODEL_STRONG=<name> \\
                         ANTHROPIC_BASE_URL=<url>
  3. Curl the public /health endpoint (anonymous, returns {"status":"ok"}):
        curl -fsS ${APIM_GATEWAY_URL:-https://$CA_FQDN}/health
  4. Smoke-test the protected API by acquiring a service-principal token
     and calling /classifications (requires the BFF app reg + a granted
     scope — see infra/bootstrap-entra.sh):
        TOKEN=\$(az account get-access-token \\
          --resource api://infp-clearai-api-dev-01 \\
          --query accessToken -o tsv)
        curl -sS -X POST \\
          -H "Authorization: Bearer \$TOKEN" \\
          -H "Content-Type: application/json" \\
          -d '{"description":"men white cotton shirt"}' \\
          ${APIM_GATEWAY_URL:-https://$CA_FQDN}/classifications
EOF
