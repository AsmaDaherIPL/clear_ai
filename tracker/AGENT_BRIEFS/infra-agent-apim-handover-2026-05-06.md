# Handover for the infra agent — APIM provisioning for ClearAI Backend

> **SUPERSEDED — 2026-05-06.** This handover was written against incorrect assumptions about your real APIM setup (wrong file paths, wrong SKU, wrong API id, wrong path, treated as greenfield). The infra agent caught all of it. See the corrected directive at [infra-agent-apim-directive-2026-05-06-corrected.md](infra-agent-apim-directive-2026-05-06-corrected.md).
>
> The corrected directive supersedes everything below. This file is preserved as historical context.

---

**Goal:** stand up the ClearAI backend's HTTP surface in Azure API Management so the SPA, partners, and internal tools can call it through a single audited gateway with Entra ID auth.

**You will not write the OpenAPI spec.** That's done — it lives at [clearai-backend/openapi.yaml](clearai-backend/openapi.yaml) and is the source of truth. Re-import it on every backend release.

**You will write Bicep + run deployments.** A starter template is at [azure-infra/apim/clearai-api.bicep](azure-infra/apim/clearai-api.bicep). Read it before you start; it's annotated with what's intentional vs. what's a placeholder.

---

## What exists today vs. what you must do

### Already in the repo (don't recreate)

| File | Purpose |
|---|---|
| `clearai-backend/openapi.yaml` | OpenAPI 3.0 spec — every live endpoint, schemas, error shapes, security requirements |
| `azure-infra/apim/clearai-api.bicep` | Bicep template — defines the API + inbound policy + per-operation policies |
| `azure-infra/apim/clearai-api.params.example.json` | Sample parameter file — copy and fill in real values |

### What you must do

1. **Confirm pre-requisites exist** in the target Azure subscription (see "Pre-requisites" below). If not, provision them first — those bits are out of scope for this handover, but flag back to me if anything's missing.
2. **Copy and fill the params file**: `cp clearai-api.params.example.json clearai-api.params.<env>.json` for each env (dev/prod), fill in real values, never commit `prod` params with secrets.
3. **Deploy** the Bicep to dev first, smoke-test, then deploy to prod. See "Deployment commands" below.
4. **Wire the deployment into CI** so future OpenAPI updates auto-redeploy. See "CI/CD wiring".
5. **Verify auth + rate limits** end-to-end with a real Entra token. See "Verification".
6. **Document anything that surprised you** — open a follow-up ADR if you had to make a design call I didn't anticipate.

---

## Pre-requisites (must already exist)

The Bicep template assumes the broader infra Bicep tree has provisioned these. Check before deploying — if any are missing, you (or whoever owns base infra) needs to add them in the parent template.

- [ ] **APIM instance** — Standard v2 or higher (Consumption tier doesn't support `validate-jwt` reliably with named values + Key Vault). Resource name → goes into `apimName` param.
- [ ] **Container App** hosting the backend, reachable on a public HTTPS FQDN. The FQDN → goes into `backendUrl` param. The Container App enforces APIM secret via its `onRequest` hook ([clearai-backend/src/server/app.ts:58](clearai-backend/src/server/app.ts:58)), so direct calls bypassing APIM are rejected.
- [ ] **Key Vault** holding the APIM shared secret. The vault must:
  - Have a secret named `apim-shared-secret` (configurable via `apimSharedSecretSecretName` param). Value: any high-entropy string, ≥20 chars. Same string is set as `APIM_SHARED_SECRET` env on the Container App.
  - Grant the APIM instance's system-assigned managed identity the `Key Vault Secrets User` RBAC role (or equivalent access policy: `Get` on secrets).
- [ ] **Entra app registration** for the backend API:
  - Application ID URI like `api://clearai-backend` → `entraAudience` param
  - At least one scope exposed (e.g. `default`)
  - The SPA's Entra app registration grants this scope (so the SPA can request tokens audienced for this API)
  - Tenant ID → `entraTenantId` param
- [ ] **APIM has a system-assigned managed identity** with vault Secrets-User role on the Key Vault (so the named-value can pull the secret).

If any of those are missing, list what's missing in your reply so I can route to the right owner.

---

## Files in detail

### 1. `clearai-backend/openapi.yaml`

OpenAPI 3.0. Defines every endpoint, every request/response schema, every error shape, and the two security schemes (`apimSharedSecret`, `entraJwt`).

**Two consumers:**
- **APIM** imports this on every deploy of the Bicep template (`loadTextContent('../../clearai-backend/openapi.yaml')`).
- **Frontend** can generate a typed TypeScript client from this file using `openapi-typescript-codegen` or similar — single source of truth.

**Update flow:**
1. Backend dev edits `openapi.yaml` to match a new/changed Fastify route.
2. PR review checks the YAML against the actual route handler.
3. Merge → CI redeploys the Bicep → APIM picks up the new operations.

### 2. `azure-infra/apim/clearai-api.bicep`

What it provisions inside the existing APIM instance:

- **A named-value** `clearai-apim-shared-secret` that pulls the secret from Key Vault on every read. Used by the inbound policy to inject `x-apim-shared-secret`.
- **An API** named `clearai-backend-v1` (configurable via `apiId`), mounted at the path you choose (default `api`), backed by the Container App URL.
- **An API-level inbound policy** that:
  1. Calls `validate-jwt` against the Entra openid-config — rejects 401 if the token's missing, expired, wrong audience, or wrong issuer.
  2. Strips the user's `Authorization` header (so the backend never sees the raw token).
  3. Sets `x-apim-shared-secret: {{clearai-apim-shared-secret}}` (the named-value, pulled from Key Vault).
  4. `rate-limit-by-key` per IP — 60/min by default, tunable via `rateLimitMax`/`rateLimitWindow` params.
  5. CORS, only emitted if `corsOrigins` is non-empty. Allowed methods: `GET, POST, PATCH, OPTIONS`. Allowed headers: `content-type, authorization`.
- **Per-operation overrides** for `GET /health` and `GET /ready` — they SKIP the validate-jwt step (no `<base/>` in the inbound section) so Container Apps probes work without an Entra token. They still inject the APIM shared secret because the backend's `onRequest` hook checks for it on every non-probe request (and the Container Apps probe path is exempted in the backend, so technically the secret isn't needed on probes — but injecting it costs nothing and keeps the policy uniform).

**Things to verify after first deploy:**
- The auto-generated operationIds match `get-health` and `get-ready`. APIM's OpenAPI import generates these from `${method}-${path-segments}`. If they end up as something different (e.g. `get-health-1`, or APIM mangles slashes in nested paths), update the per-operation policy resource names in the Bicep to match what's generated.
- The `loadTextContent` resolves to the right path. The relative path in the Bicep is `../../clearai-backend/openapi.yaml` (Bicep is at `azure-infra/apim/`, OpenAPI is at `clearai-backend/`). If you move the Bicep, update the path.

### 3. `clearai-api.params.example.json`

Sample params file. Copy and rename per environment. **Never commit a params file containing the real `apimName`, `keyVaultName`, or `entraTenantId` to a public repo** — those aren't secrets per se but they're useful reconnaissance for an attacker. Add `clearai-api.params.dev.json` and `clearai-api.params.prod.json` to `.gitignore`, OR use a deploy-time variable substitution in CI.

---

## Deployment commands

### Manual one-time deploy (dev)

```bash
# 1. Log in
az login
az account set --subscription <SUBSCRIPTION_ID>

# 2. Copy params and fill in real values
cd azure-infra/apim
cp clearai-api.params.example.json clearai-api.params.dev.json
# Edit clearai-api.params.dev.json — set apimName, backendUrl, entraTenantId, keyVaultName, corsOrigins

# 3. Validate first (catches Bicep errors before any Azure call)
az deployment group validate \
  --resource-group <DEV_RG> \
  --template-file clearai-api.bicep \
  --parameters @clearai-api.params.dev.json

# 4. Preview what will change (what-if)
az deployment group what-if \
  --resource-group <DEV_RG> \
  --template-file clearai-api.bicep \
  --parameters @clearai-api.params.dev.json

# 5. Deploy
az deployment group create \
  --resource-group <DEV_RG> \
  --template-file clearai-api.bicep \
  --parameters @clearai-api.params.dev.json
```

### Pure OpenAPI re-import (faster path; skips the Bicep diff)

If you only changed `openapi.yaml` and don't need to touch policies / named values, you can re-import via CLI without redeploying the Bicep:

```bash
az apim api import \
  --resource-group <RG> \
  --service-name <APIM_NAME> \
  --api-id clearai-backend-v1 \
  --path api \
  --specification-format OpenApi \
  --specification-path ../../clearai-backend/openapi.yaml \
  --display-name "ClearAI Backend API"
```

This **does not** re-apply the inbound policy. If you change policies, run the full Bicep deploy.

---

## CI/CD wiring

Goal: every PR that merges and changes `clearai-backend/openapi.yaml` triggers a redeploy to dev. Manual approval to promote to prod.

**Recommended pattern** (GitHub Actions, since the repo is on GitHub):

1. Add a workflow `.github/workflows/deploy-apim.yaml` that:
   - Triggers on push to `main` when `clearai-backend/openapi.yaml` OR `azure-infra/apim/**` changes.
   - Logs in with the federated OIDC credential for the dev subscription (no long-lived secrets).
   - Runs `az deployment group create` with `clearai-api.params.dev.json`.
   - Runs the verification curl probes (see below) to confirm the deploy worked.
   - Posts a comment on the PR (or sends a Slack ping) with the result.
2. Add a separate manual-trigger workflow `deploy-apim-prod.yaml` for prod, gated by `environments: production` with required reviewers.

**Federated credentials** (so you don't store an SP secret in GitHub): see the Microsoft docs for [Configure GitHub Actions OIDC with Entra ID](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure?tabs=azure-cli%2Clinux). The federated credential's subject claim should be tied to a specific repo + branch (`repo:owner/clear_ai:ref:refs/heads/main`).

I can scaffold the workflow if you want — say the word. For now I've left it out so you can choose your preferred CI shape.

---

## Verification

After the first deploy, run these from a local terminal to prove the wiring works.

```bash
# Set what you need
APIM_HOST="<APIM_GATEWAY_HOST>"           # e.g. clearai-apim.azure-api.net
ENTRA_TOKEN="$(az account get-access-token --resource api://clearai-backend --query accessToken -o tsv)"

# 1. /health and /ready — no auth required
curl -i "https://${APIM_HOST}/api/health"
curl -i "https://${APIM_HOST}/api/ready"
# Expected: 200 ok / 200 ready (or 503 warming if just deployed)

# 2. /declaration-runs without a token — should be 401 from APIM
curl -i -X POST "https://${APIM_HOST}/api/declaration-runs"
# Expected: 401 from validate-jwt

# 3. /declaration-runs with a fake token — should be 401
curl -i -X POST -H "Authorization: Bearer not.a.real.token" \
  "https://${APIM_HOST}/api/declaration-runs"
# Expected: 401 from validate-jwt

# 4. /declaration-runs with a real token but no body — should be 400 from the backend
curl -i -X POST -H "Authorization: Bearer ${ENTRA_TOKEN}" \
  "https://${APIM_HOST}/api/declaration-runs"
# Expected: 400 declaration_run_validation_failed (proves: APIM stripped the token,
# injected the shared secret, and forwarded to the backend)

# 5. Rate limit — fire 100 health requests in <60s
for i in $(seq 1 100); do curl -s -o /dev/null -w "%{http_code}\n" "https://${APIM_HOST}/api/health"; done | sort | uniq -c
# Expected: probes are exempt, all 200. If you do this against /declaration-runs/<id> you'll see 429s after 60.

# 6. Direct call to the backend (bypassing APIM) — should be 401 from the backend
BACKEND_FQDN="<CONTAINER_APP_FQDN>"
curl -i "https://${BACKEND_FQDN}/declaration-runs/00000000-0000-0000-0000-000000000000"
# Expected: 401 origin_access_denied (proves the backend's APIM-secret guard works)
```

If any of those don't match expected, dig into APIM's request trace (Portal → APIs → clearai-backend-v1 → Test → enable trace).

---

## Open design questions (your call)

1. **Subscription keys?** The Bicep sets `subscriptionRequired: false` because Entra is the auth boundary. If you want to add subscription keys for partner-issued non-Entra access (e.g. a webhook callback), flip that and provision a product. I'd recommend NOT, to keep one auth path — but flag if you have a partner that can't use Entra.
2. **Multi-region?** The Bicep deploys into one APIM instance. If we eventually need APIM in two regions, the OpenAPI import still works the same; just deploy the Bicep to the second instance. Active-active routing happens at Front Door, not APIM.
3. **Versioning strategy?** Today the API is `clearai-backend-v1` with path `api`. When v2 ships, the recommended pattern is a new APIM API resource (`clearai-backend-v2`) with path `api/v2`. Both can coexist; clients pick. Open an ADR when you're ready to ship v2.
4. **Developer portal?** APIM ships with a publishable developer portal. If you want partners (or even internal devs) to self-serve, publish it. Out of scope here.

---

## What I'm not doing

- Not provisioning APIM, the Container App, the Key Vault, or the Entra app registration — those are pre-reqs.
- Not writing the GitHub Actions workflow (will if asked).
- Not setting up the developer portal.
- Not publishing API documentation (the OpenAPI YAML is the source; pick a renderer like Redoc/Swagger UI later).
- Not adding partner-specific API products / subscription keys.
- Not setting up custom domains for APIM (e.g. `api.clearai.com` instead of `*.azure-api.net`) — out of scope; if you do this, the OpenAPI's `servers:` section needs updating.

---

## Questions for me (the backend agent)

If during your work you hit:

- **An OpenAPI shape that doesn't match the actual Fastify handler** → ping back. The YAML is the source of truth and either the YAML is wrong or the handler is wrong; I'll fix whichever it is.
- **A new endpoint shipped by the backend that's not in the YAML yet** → ask. I'll add it.
- **An Entra-claim or token-format question** (e.g. "the validate-jwt is rejecting because the token has `appid` but not `aud`") → ping. We may need to add a `<required-claims>` block to the policy.

---

## Definition of done

- [ ] `az deployment group create` succeeds in dev with no warnings.
- [ ] All 6 verification curls in the "Verification" section pass.
- [ ] Frontend SPA can call `/declaration-runs` end-to-end with a real user-Entra token.
- [ ] Direct calls to the Container App FQDN are rejected with 401.
- [ ] Rate-limit returns 429 after the configured threshold.
- [ ] CI workflow (or documented manual procedure) for redeploying when `openapi.yaml` changes.
- [ ] Same deployed and verified in prod, with manual approval.
- [ ] Brief follow-up note (in a new file under `tracker/AGENT_BRIEFS/`) covering anything you had to deviate from this handover for.

Ping when done or stuck.
