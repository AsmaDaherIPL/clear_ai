#!/usr/bin/env bash
# fix-pg-ip — add the laptop's current public IP to the dev Postgres firewall.
#
# Why: ISPs hand out short-lived public IPs. Every time it rotates, the dev
# Postgres firewall (single-IP rule) drops you. Running this script reads the
# current public IP, compares against existing firewall rules, and adds a new
# rule if needed. Idempotent — safe to run repeatedly.
#
# Usage:
#   pnpm fix-pg-ip                    # from clearai-backend/
#   ./local-dev/scripts/fix-pg-ip.sh  # direct
#
# Requires: az (logged in to the ClearAI sub) + curl.
# No other deps.

set -euo pipefail

PG_SERVER="psql-infp-clearai-dev-gwc-01"
RG="rg-infp-clearai-common-dev-gwc-01"
SUB="6e9d19dc-d200-4be3-810f-cc4e920608c8"
RULE_PREFIX="AllowOperator_"

# Helpful colours (only when stdout is a tty).
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""
fi

step()  { echo "${DIM}→${RESET} $*"; }
ok()    { echo "${GREEN}✓${RESET} $*"; }
warn()  { echo "${YELLOW}⚠${RESET} $*" >&2; }
fail()  { echo "${RED}✗${RESET} $*" >&2; exit 1; }

# Pre-flight: az CLI installed + logged in to the right sub.
command -v az >/dev/null 2>&1 || fail "az CLI not installed. brew install azure-cli"
CURRENT_SUB=$(az account show --query id -o tsv 2>/dev/null || true)
if [[ -z "$CURRENT_SUB" ]]; then
  fail "az CLI not logged in. Run: az login --tenant 4efdd8aa-2f8d-484d-bd3a-69be8b52e740"
fi
if [[ "$CURRENT_SUB" != "$SUB" ]]; then
  step "Switching subscription → ${SUB} (was ${CURRENT_SUB})"
  az account set --subscription "$SUB"
fi

# 1. What is my public IP right now?
step "Detecting current public IP..."
MY_IP=$(curl -s --max-time 10 https://api.ipify.org || true)
if [[ -z "$MY_IP" ]] || [[ ! "$MY_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Could not detect public IP from api.ipify.org. Network down?"
fi
ok "Public IP: ${MY_IP}"

# 2. Is this IP already in the firewall?
step "Reading existing firewall rules..."
RULES_JSON=$(az postgres flexible-server firewall-rule list \
  --name "$PG_SERVER" --resource-group "$RG" -o json)

ALREADY=$(echo "$RULES_JSON" | python3 -c "
import sys, json
rules = json.load(sys.stdin)
for r in rules:
    if r['startIpAddress'] == '$MY_IP' and r['endIpAddress'] == '$MY_IP':
        print(r['name']); break
")

if [[ -n "$ALREADY" ]]; then
  ok "Already allowed by rule '${ALREADY}'. Nothing to do."
  echo ""
  echo "Existing rules:"
  echo "$RULES_JSON" | python3 -c "
import sys, json
rules = json.load(sys.stdin)
for r in rules:
    print(f\"  {r['name']:48} {r['startIpAddress']}\")
"
  exit 0
fi

# 3. Add a new rule for the current IP.
RULE_NAME="${RULE_PREFIX}$(date +%Y%m%d_%H%M%S)"
step "Adding rule ${RULE_NAME} for ${MY_IP}..."
az postgres flexible-server firewall-rule create \
  --resource-group "$RG" --name "$PG_SERVER" \
  --rule-name "$RULE_NAME" \
  --start-ip-address "$MY_IP" --end-ip-address "$MY_IP" \
  --query "{name:name, ip:startIpAddress}" -o tsv >/dev/null
ok "Rule added."

# 4. Tidy up — drop any operator-rule older than 24h so we don't accumulate
#    a forest of stale IPs over weeks. Today's rule (just created) is exempt.
step "Pruning old operator rules (>24h)..."
NOW_S=$(date +%s)
DROPPED=0
echo "$RULES_JSON" | python3 -c "
import sys, json, re
from datetime import datetime, timezone
rules = json.load(sys.stdin)
now = int($NOW_S)
for r in rules:
    name = r['name']
    if not name.startswith('$RULE_PREFIX'):
        continue
    # Try to parse the timestamp embedded in the name.
    m = re.search(r'(\d{8}_\d{4,6})', name)
    if not m:
        continue
    raw = m.group(1)
    # Two formats appear historically: YYYYMMDD_HHMM and YYYYMMDD_HHMMSS.
    fmt = '%Y%m%d_%H%M%S' if len(raw) == 15 else '%Y%m%d_%H%M'
    try:
        # Treat as local-tz (we generated it with \`date\`).
        ts = datetime.strptime(raw, fmt).timestamp()
    except ValueError:
        continue
    age_h = (now - ts) / 3600
    if age_h > 24:
        print(name)
" | while IFS= read -r stale_rule; do
  [[ -z "$stale_rule" ]] && continue
  step "  dropping ${stale_rule}"
  az postgres flexible-server firewall-rule delete \
    --resource-group "$RG" --name "$PG_SERVER" \
    --rule-name "$stale_rule" --yes >/dev/null 2>&1 && DROPPED=$((DROPPED+1)) || true
done

# 5. Final state.
echo ""
ok "Done."
echo ""
echo "Current firewall:"
az postgres flexible-server firewall-rule list \
  --name "$PG_SERVER" --resource-group "$RG" \
  --query "[].{name:name, ip:startIpAddress}" -o table

echo ""
echo "${DIM}Tip: Postgres propagation can take 30-60s. If VS Code still times out,${RESET}"
echo "${DIM}     wait a minute and reconnect. Try \`pnpm db:ping\` to test from CLI.${RESET}"
