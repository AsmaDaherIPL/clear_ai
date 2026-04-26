# ClearAI Backend - Infrastructure (dev)

Bicep IaC for the **ClearAI backend** dev environment in `sub-infp-clearai-nonprod-gwc`.

> Scope: this folder provisions backend infra only — Postgres, Key Vault,
> Container Apps. The frontend (`../../clearai-frontend`, deployed to
> Cloudflare Pages) and wiki (`../../clearai-wiki`) have their own pipelines
> and are not touched here.

```
clearai-backend/infra/
├── main.bicep                 # Orchestrator (RG-scoped)
├── main.dev.bicepparam        # Dev parameters
├── deploy.sh                  # Idempotent wrapper script
└── modules/
    ├── postgres.bicep         # PG Flex B1ms + extensions + firewall + DB
    ├── keyvault.bicep         # KV (Standard, RBAC, soft-delete)
    ├── keyvault-secrets.bicep # postgres-password / -conn-string / anthropic-api-key
    ├── containerapps-env.bicep# Consumption env, no Log Analytics
    ├── containerapp.bicep     # Backend app, system-assigned MI, secretref to KV
    └── networkwatcher.bicep   # Optional regional NW fallback
```

## What gets deployed

| Resource          | Name                                    | Tier / Notes                              |
|-------------------|-----------------------------------------|-------------------------------------------|
| Postgres Flex     | `psql-infp-clearai-dev-gwc-01`          | B1ms, PG 16, 32 GB, 7-day backup, public+SSL |
| Postgres DB       | `clearai`                               | with VECTOR, PG_TRGM, UNACCENT, PGCRYPTO  |
| Key Vault         | `kv-infp-clearai-dev-gwc`               | Standard, RBAC, soft-delete on            |
| Container Apps Env| `cae-infp-clearai-dev-gwc-01`           | Consumption only, no Log Analytics        |
| Container App     | `ca-infp-clearai-be-dev-gwc-01`         | min=0/max=2, 0.5 vCPU / 1 GiB             |
| Network Watcher   | regional singleton (auto-detected)      | created only if missing                   |

Cost at idle: **~$13–15 / month** (Postgres B1ms is the only always-on cost).
Container App scales to zero. KV first 10k ops / month are free.

## Prerequisites

- `az` CLI ≥ 2.60 — `az --version`
- `python3` (used to generate the password and url-encode it)
- Logged in: `az login --tenant 4efdd8aa-2f8d-484d-bd3a-69be8b52e740`
- **Subscription Contributor** on `sub-infp-clearai-nonprod-gwc` (granted)
- **User Access Administrator** OR **Owner** on the resource group (needed
  for the role assignment in step 8 of `deploy.sh`).
- A real Anthropic key (optional at first deploy — placeholder is fine):
  ```bash
  export ANTHROPIC_API_KEY="sk-ant-..."
  ```

## Deploy

```bash
cd clearai-backend/infra
./deploy.sh
```

`deploy.sh` is idempotent — re-run it any time. It will:

1. Set the active subscription
2. Verify the resource group exists
3. Register required resource providers (no-op if already registered)
4. Pre-flight: confirm KV name is globally available (fails clearly if not)
5. Pre-flight: detect existing regional Network Watcher
6. Auto-detect your operator IP for the Postgres firewall
7. Generate (or reuse from KV) the 32-char Postgres admin password
8. Run the Bicep deployment
9. Assign the Container App MI **Key Vault Secrets User** on the KV
10. Restart the latest revision so `secretref` values resolve
11. Print outputs (no secrets) + next-step hints

## Post-deploy checklist

- [ ] Set the real Anthropic key:
  ```bash
  az keyvault secret set --vault-name kv-infp-clearai-dev-gwc \
    --name anthropic-api-key --value "sk-ant-..."
  ```
- [ ] Once Foundry models are renamed, set the model env vars:
  ```bash
  az containerapp update \
    --name ca-infp-clearai-be-dev-gwc-01 \
    --resource-group rg-infp-clearai-common-dev-gwc-01 \
    --set-env-vars \
      ANTHROPIC_BASE_URL="https://<foundry-endpoint>" \
      LLM_MODEL="claude-haiku-4-5-clearai-dev" \
      LLM_MODEL_STRONG="claude-sonnet-4-6-clearai-dev"
  ```
- [ ] Apply DB extensions inside the `clearai` database (one-time):
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS unaccent;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  ```
- [ ] Smoke-test:
  ```bash
  curl -fsS https://<containerapp-fqdn>/health
  ```

## Read-back commands (no Portal needed)

```bash
# All app outputs
cat /tmp/clearai-deploy-output.json | jq '.properties.outputs'

# Postgres FQDN
az postgres flexible-server show \
  --name psql-infp-clearai-dev-gwc-01 \
  --resource-group rg-infp-clearai-common-dev-gwc-01 \
  --query fullyQualifiedDomainName -o tsv

# Container App FQDN
az containerapp show \
  --name ca-infp-clearai-be-dev-gwc-01 \
  --resource-group rg-infp-clearai-common-dev-gwc-01 \
  --query properties.configuration.ingress.fqdn -o tsv

# Postgres password (only if you need it locally)
az keyvault secret show \
  --vault-name kv-infp-clearai-dev-gwc \
  --name postgres-password --query value -o tsv
```

## What's NOT in dev (TODO for prod)

When promoting to a prod environment:

- [ ] Key Vault: enable **purge protection** (`enablePurgeProtection: true`)
- [ ] Postgres: switch to **HA + zone-redundant backups**, scale up from B1ms
- [ ] Postgres: drop **public access**, attach via Private Endpoint + delegated subnet
- [ ] Container Apps: enable **Log Analytics** destination + Application Insights
- [ ] Container Apps: pin to a **specific image digest**, not `:latest`
- [ ] Add **APIM** in front of the Container App (Flow 2)
- [ ] Replace operator-IP firewall rule with **VNet integration**
- [ ] Add **alerts**: Postgres CPU/storage, Container App restarts, KV access errors
- [ ] Move the deployment to a **CI/CD pipeline** (GitHub Actions w/ OIDC) instead of `deploy.sh`

## Troubleshooting

**"Key Vault name not available"**
The KV name is global. Edit `KV_NAME` in `deploy.sh` and `keyVaultName` in
`main.dev.bicepparam` together. Stay ≤ 24 chars.

**"AuthorizationFailed: ... role assignment"**
You need User Access Administrator (or Owner) on the RG. Ask Vinko.
The Bicep deploy itself will succeed — only step 8 (`az role assignment create`)
fails. You can retry just that step after permissions land.

**Container App stuck `Activating` / 503**
Check `az containerapp logs show -n ca-infp-clearai-be-dev-gwc-01 -g rg-infp-clearai-common-dev-gwc-01 --follow`.
Most common cause: KV role hasn't propagated yet — wait 60s and restart the revision.

**Postgres "no pg_hba.conf entry"**
Your IP changed. Re-run `./deploy.sh` — it re-detects the IP and updates the firewall.
