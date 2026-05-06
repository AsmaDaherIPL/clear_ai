# Corrected APIM directive for the infra agent — 2026-05-06

**Supersedes:** [infra-agent-apim-handover-2026-05-06.md](infra-agent-apim-handover-2026-05-06.md)

The earlier handover had multiple wrong assumptions about your real APIM setup. You called those out correctly. This directive replaces it.

## Acknowledgements (what I got wrong)

| What I prescribed | Actual reality |
|---|---|
| Bicep at `azure-infra/apim/clearai-api.bicep` | Bicep is at `clearai-backend/infra/modules/apim.bicep` (~520 lines, mature). The `azure-infra/apim/` tree was a phantom I created. **Already deleted in this commit.** |
| SKU "Standard v2 or higher" | Consumption tier. `validate-jwt` works on it; cost is ~$0 idle. Stay on Consumption. |
| Greenfield provisioning | Already deployed, two APIs (`clearai-backend`, `clearai-backend-public`), 5 live operations, working policy. |
| API ID `clearai-backend-v1`, path `api` | Real API id is `clearai-backend`, path is `''`. Gateway URLs are `apim.../<endpoint>` (no `/api` prefix). |
| "APIM strips Authorization before forwarding" | Authorization is forwarded. Useful for audit/identity in new endpoints. |
| "Standalone openapi.yaml not in scope" | OpenAPI YAML at `clearai-backend/openapi.yaml` is updated to reflect the real contract. |

## What's already done in this PR

1. **Deleted `azure-infra/apim/`** — the parallel tree is gone. Only `clearai-backend/infra/modules/apim.bicep` exists for APIM Bicep.
2. **Fixed `clearai-backend/openapi.yaml`:**
   - `servers:` URL now `https://{apim-host}` (no `/api`), matching `path: ''`.
   - Auth doc rewritten: APIM forwards Authorization (doesn't strip it).
   - `/health` documented as APIM-short-circuit (anonymous, returns canned `{"status":"ok"}` from APIM).
3. **Confirmed the backend's `APIM_SHARED_SECRET` check is correct** — load-bearing defence against direct-to-Container-App bypass. Don't delete it.

## What you need to do

### Scope: **Option 2 — refactor existing apim.bicep to OpenAPI import.**

The user's call: SPA migration is cheap, focus on backend correctness. Don't preserve the legacy `/classifications/*` operations — they 404 on the backend now anyway (the legacy single-shot classifier was deleted in commit `107b87c` of `main`). Delete them from APIM and add the new pipeline operations.

### File to edit

`clearai-backend/infra/modules/apim.bicep` — modify the existing file. Don't create new ones.

### What to keep (don't touch)

- The APIM service resource (lines ~178–196) — Consumption SKU, system-assigned MI.
- The `apim-shared-secret` named value (lines ~209–217) and `deploy.sh`'s flip-to-KV-backed step.
- The `apiInboundPolicyXml` (line 167) — CORS + validate-jwt + shared-secret strip+inject + rate-limit. This stays the API-level inbound policy.
- The `publicInboundPolicyXml` (line 172) and the `clearai-backend-public` API + its `/health` short-circuit operation. Anonymous probe stays.
- The `clearai` product + product-API link (lines ~458–475).
- Diagnostic settings (lines ~490–512).

### What to remove

- The 5 `op*` resources for the legacy `/classifications/*` endpoints (lines ~275–392):
  - `opClassificationsCreate`
  - `opClassificationsExpand`
  - `opClassificationsGet`
  - `opClassificationsSubmissionDescription`
  - `opClassificationsFeedback`
- These map to backend routes that no longer exist on `main`. Removing them stops APIM from forwarding requests to a 404.

### What to add

The new pipeline endpoints. Two ways to add them; pick one:

**Approach A — OpenAPI import (recommended; matches the user's "single source of truth" goal).**

Add a new resource on the `apiProtected` API that imports `clearai-backend/openapi.yaml`. Replace the inline `op*` definitions with the import — APIM creates one operation per OpenAPI path.

Sketch:

```bicep
resource apiProtectedSpec 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'clearai-backend'
  properties: {
    displayName: 'ClearAI Backend'
    description: '...'
    path: ''
    protocols: [ 'https' ]
    serviceUrl: backendUrl
    subscriptionRequired: false
    apiType: 'http'
    type: 'http'
    format: 'openapi'
    value: loadTextContent('../../openapi.yaml')
  }
}
```

Note: `loadTextContent('../../openapi.yaml')` — relative path from `clearai-backend/infra/modules/apim.bicep` to `clearai-backend/openapi.yaml`. Verify that resolves; if not, adjust.

The OpenAPI YAML covers all 6 currently-live backend endpoints:
- `GET /health` (will be auto-imported but is also served by the public API; either skip importing it or remove the public API — your call. I lean toward keeping the public API as-is and adding `x-internal: true` to the OpenAPI's `/health` path so APIM dedup'd.)
- `GET /ready`
- `POST /declaration-runs` (multipart, 25 MB cap)
- `GET /declaration-runs/{id}`
- `GET /declaration-runs/{id}/classifications`
- `PATCH /declaration-runs/{id}`
- `POST /pipeline/submission-description`

After import, **the existing `apiProtectedPolicy` (the API-level inbound policy with validate-jwt + shared-secret + rate-limit) applies to ALL imported operations automatically** because it's set at the API level, not per-operation. You don't need to re-declare it.

**Approach B — Inline operations (simpler, less moving parts).**

Replace the 5 deleted `op*` resources with 7 new ones (one per pipeline endpoint), in the same Bicep style as the existing operations. The OpenAPI YAML becomes documentation only, not the import source. Use approach B if approach A's `loadTextContent` path or APIM operationId mangling becomes a hassle.

### Per-operation policy override for `/ready`

`/ready` (the readiness probe) needs the same shared-secret injection but **may want to skip validate-jwt** so that Container Apps probes can hit it without a bearer token.

If you want `/ready` to be reachable as a Container Apps health probe via APIM (probably not — Container Apps probes the Container App directly), leave `/ready` requiring validate-jwt and let admins hit it manually with a bearer.

If you want `/ready` anonymous, add a per-operation policy (similar to the public `/health` API), but on the protected API. Pattern:

```bicep
resource opReadyPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  name: '${apim.name}/${apiProtected.name}/<operationId-for-ready>/policy'
  properties: {
    format: 'rawxml'
    value: '<policies><inbound>...no base/, no validate-jwt...</inbound>...</policies>'
  }
}
```

User can decide. My recommendation: leave `/ready` requiring auth — Container Apps probes the Container App directly, not through APIM, so this isn't needed.

### CORS implication for the new endpoints

The existing `corsAllowedOrigins` allowlist (line 137) is fine for the SPA + dev ports + custom domain. Adding `PATCH` to `<allowed-methods>` is required because `PATCH /declaration-runs/{id}` is a new method. Today's policy only lists GET, POST, OPTIONS — browser preflights for the new PATCH will fail.

```diff
       <allowed-methods preflight-result-max-age="600">
         <method>GET</method>
         <method>POST</method>
+        <method>PATCH</method>
         <method>OPTIONS</method>
       </allowed-methods>
```

### About the user-identity forwarding

The current policy forwards `Authorization` to the backend. New backend endpoints can read user claims for audit (e.g. who created a declaration_run). This is a per-endpoint backend implementation choice — no APIM change needed. If you'd rather extract specific claims into headers (`x-user-oid`, `x-user-email`) and strip Authorization, that's a defensible alternative; let me know if you want that and I'll add it to the OpenAPI security model.

For v0 we ship "Authorization-forwarded, backend ignores"; the user-identity story can be bolted on later.

## Verification

After deploy:

```bash
# 1. /health (public, anonymous)
curl -i "https://{apim-host}/health"
# Expected: 200 {"status":"ok"} from APIM short-circuit

# 2. /ready without token
curl -i "https://{apim-host}/ready"
# Expected: 401 (validate-jwt) — assuming /ready is protected

# 3. Real bearer token, no body, against /declaration-runs
TOKEN="$(az account get-access-token --resource api://infp-clearai-api-dev-01 --query accessToken -o tsv)"
curl -i -X POST "https://{apim-host}/declaration-runs" -H "Authorization: Bearer $TOKEN"
# Expected: 400 declaration_run_validation_failed (proves: APIM validated JWT,
# injected shared secret, forwarded to backend, backend rejected the bad body)

# 4. POST /pipeline/submission-description with bad code
curl -i -X POST "https://{apim-host}/pipeline/submission-description" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"description":"x","code":"BADCODE"}'
# Expected: 400 invalid_body

# 5. Direct-to-Container-App bypass attempt
BACKEND_FQDN="<container-app-fqdn>"
curl -i "https://${BACKEND_FQDN}/declaration-runs/00000000-0000-0000-0000-000000000000"
# Expected: 401 origin_access_denied (proves shared-secret defence-in-depth still works)

# 6. Old /classifications endpoint
curl -i -X POST "https://{apim-host}/classifications" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{}'
# Expected after this PR: 404 (operation removed from APIM)
```

## CI auto-redeploy

The user wants the OpenAPI to be the source of truth. After the refactor, any commit that changes `clearai-backend/openapi.yaml` should trigger an APIM redeploy. Wire it into your existing `deploy.sh` or whatever CI mechanism you use; I'll defer to your judgement on the GitHub Actions / Azure DevOps shape.

## Definition of done

- [ ] `azure-infra/apim/` removed (already removed in this PR)
- [ ] 5 legacy `/classifications/*` operations removed from `apim.bicep`
- [ ] 7 new pipeline operations added (either via OpenAPI import or inline — your pick)
- [ ] `PATCH` added to CORS `allowed-methods`
- [ ] `apim-shared-secret` named value untouched (already wired)
- [ ] All 6 verification curls pass
- [ ] `deploy.sh` runs cleanly end-to-end in dev
- [ ] SPA's BFF/MSAL flow updated to call the new URLs (this is a separate task on the frontend agent — not your scope, but flag if you see anything that'll break it)

## Open questions back to me (the backend agent)

- **Approach A vs B** on operation definition? Default A. If `loadTextContent` path resolution or operationId generation gives you trouble, fall back to B.
- **`/ready` auth requirement?** Default: leave it requiring validate-jwt.
- **Identity-forwarding pattern?** Default: keep forwarding Authorization, no header transforms.

If any of those are blockers, ping me. Otherwise: ship it.
