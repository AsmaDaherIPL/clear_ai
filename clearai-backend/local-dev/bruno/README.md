# Bruno collection — ClearAI Backend API

File-based API client (Bruno) for hand-testing every live endpoint. Lives next to the code so it's version-controlled and reviewable in PRs.

Bruno docs: https://docs.usebruno.com

---

## Why Bruno (not Postman)

- **Files in git.** Each request is a `.bru` text file. Diffs are reviewable. No proprietary cloud sync.
- **Same collection, two environments.** `localhost.bru` vs `dev-apim.bru` — flip with one click.
- **OAuth baked in.** Collection-level OAuth2 / Authorization Code + PKCE. Browser auth flow on first send; auto-refresh after that.

---

## Setup (one-time)

1. Install Bruno: https://www.usebruno.com/downloads
2. In Bruno: **Open Collection** (NOT Import) → pick the folder
   `clearai-backend/local-dev/bruno/`. This opens the whole collection;
   `bruno.json` at the root is the marker.
3. Top-right environment dropdown → pick **`dev-apim`** (or `localhost`
   for local backend).

You should now see in the left sidebar:

```
ClearAI Backend
├── declaration-runs/
├── pipeline/
└── probes/
```

Don't use the **Import** dialog: that's for converting Postman/Insomnia exports, not for opening Bruno collections. The button you want is "Open Collection" (or "Open Existing Collection" / a folder icon in the sidebar header — varies by version).

---

## Environments

| Environment | When to use | `baseUrl` | Auth |
|---|---|---|---|
| `localhost` | Backend running locally via `pnpm dev` (or `docker-compose.full.yml`). | `http://localhost:3000` | None — Fastify accepts unauthenticated requests in `NODE_ENV=development`. |
| `dev-apim` | Live deployed APIM. | `https://apim-infp-clearai-be-dev-gwc-01.azure-api.net` | OAuth2 / Authorization Code + PKCE against Entra. Auto-handled by collection-level auth. |

`dev-apim` exposes:
- `baseUrl` — APIM gateway URL
- `operatorSlug` — defaults to `naqel`
- `realCode` — a 12-digit HS code that exists in the seeded catalog
- `fakeUuid` — known-bad UUID for negative testing
- `tenantId` — Entra tenant id
- `cliClientId` — public CLI app reg (uses PKCE, no secret)
- `apiAudience` — protected API's App ID URI
- `apiScope` — `{{apiAudience}}/access_as_user`, the delegated permission
- `bearerToken` — secret, auto-filled by Bruno after OAuth completes

---

## OAuth — auto-configured

The collection root contains a `collection.bru` file with the OAuth2 config. Every request inherits it (`auth: inherit`). You don't need to set anything manually — just hit Send.

### Config the collection ships with

| Field | Value |
|---|---|
| Grant type | Authorization Code |
| Callback | `http://localhost` |
| Authorization URL | `https://login.microsoftonline.com/{{tenantId}}/oauth2/v2.0/authorize` |
| Access token URL | `https://login.microsoftonline.com/{{tenantId}}/oauth2/v2.0/token` |
| Client ID | `{{cliClientId}}` (ClearAI CLI DEV) |
| Client Secret | empty (public client) |
| Scope | `{{apiScope}} openid profile offline_access` |
| Code Challenge Method | SHA-256 (PKCE) |
| Client Authentication | **send credentials in BODY** (not Basic Auth header) |
| Auto-fetch token | Yes |
| Auto-refresh token | Yes |

The "send credentials in body" detail is critical: the CLI client is public, no `client_secret`. Microsoft's token endpoint rejects empty Basic Auth with `400 invalid_request`. Sending `client_id` as a form field instead works.

### First-time auth flow

1. Make sure the top-right environment dropdown shows **`dev-apim`**.
2. Click any request that uses auth (e.g. `pipeline/01_dispatch`) → hit Send.
3. Browser opens → Microsoft login → enter your `@infinitepl.com` credentials + MFA.
4. **First time only:** consent screen for `access_as_user` → click Accept.
5. Browser redirects to `http://localhost` (will look like "site can't be reached" — this is expected and correct, Bruno is intercepting the redirect).
6. Bruno popup: "Use Token" → click it.
7. Token now stored. The original Send fires automatically; subsequent Sends reuse the cached token. After ~60 min the refresh token kicks in silently.

---

## What's in the collection

```
local-dev/bruno/
├── bruno.json               collection marker
├── collection.bru           collection-level OAuth2 config
├── environments/
│   ├── localhost.bru        baseUrl + helper vars (no OAuth)
│   └── dev-apim.bru         baseUrl + OAuth vars (tenantId, etc.)
├── probes/
│   ├── 01_health.bru        GET /health           (no auth)
│   └── 02_ready.bru         GET /ready            (auth)
├── declaration-runs/
│   ├── fixtures/
│   │   └── sample-1-row.csv minimal Naqel-shape upload
│   ├── 01_create.bru        POST /declaration-runs    (multipart, auto-stores lastRunId)
│   ├── 02_get.bru           GET  /declaration-runs/:id
│   ├── 03_classifications.bru GET /declaration-runs/:id/classifications
│   └── 04_cancel.bru        PATCH /declaration-runs/:id   {status:cancelled}
└── pipeline/
    ├── 01_dispatch.bru                  POST /pipeline/dispatch    (auto-stores lastDispatchItemId)
    ├── 02_dispatch_with_code.bru        POST /pipeline/dispatch    (with merchant_code)
    ├── 03_trace_get.bru                 GET  /pipeline/trace/:id
    └── 04_submission_description.bru    POST /pipeline/submission-description
```

---

## Recommended test flows

### Quick health check

1. `probes/01_health` (no auth) → 200
2. `probes/02_ready` (auth) → 200 after warmup, 401 without token, 503 if APIM was just redeployed

### End-to-end declaration run (~10–60s)

1. `declaration-runs/01_create` — uploads `sample-1-row.csv`. Post-response script auto-stores `declaration_run_id` into the collection variable `lastRunId` for the next requests.
2. `declaration-runs/02_get` — poll until `classification_status: "completed"`.
3. `declaration-runs/03_classifications` — inspect per-item results (`final_code`, `sanity_verdict`, full `trace`).
4. `declaration-runs/04_cancel` — only if you want to abort mid-flight.

### Single-shot pipeline (~5–15s)

1. `pipeline/01_dispatch` — single description, no merchant code. Returns full `PipelineResult` with trace.
2. `pipeline/02_dispatch_with_code` — same description with a merchant 6-digit prefix; verify Track A and Track B agree (or note the disagreement in `trace.verdict`).
3. `pipeline/04_submission_description` — generate the ZATCA Arabic for a chosen code.

### Trace replay

`pipeline/03_trace_get` — uses an item id from a real `declaration-runs` classifications response (single-shot dispatch results aren't persisted).

---

## Common errors and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `400 invalid_request` on token endpoint | Client Authentication is "Basic Auth Header" instead of "Request Body" | Open `collection.bru` and verify `credentials_placement: body` |
| `tenant '{{tenantId}}' not found` | `dev-apim` environment not selected | Pick `dev-apim` from the top-right dropdown |
| `AADSTS50011: redirect URI not registered` | Callback URL doesn't match the ClearAI CLI DEV app reg | Verify the app reg's redirect URIs include `http://localhost` |
| `AADSTS65001: user has not consented` | First-time consent not yet granted on this account | Complete the consent screen during Get Access Token |
| `AADSTS70011: scope is invalid` | Scope string typo — common for `api://...` URIs | Verify `{{apiScope}}` resolves to `api://e39436da-.../access_as_user` |
| 401 from APIM despite valid token | Token is v1.0 (issuer `sts.windows.net`) | Clear and re-fetch token; API app reg has `requestedAccessTokenVersion: 2` |
| Bruno fails OAuth on `localhost` env | OAuth config inherits but localhost has no `tenantId` | Either ignore (request still goes through; localhost backend doesn't check) OR set request's `auth: none` for that file |

---

## Auth behaviour by environment

| Endpoint | localhost | dev-apim (no token) | dev-apim (bad token) | dev-apim (valid token) |
|---|---|---|---|---|
| `GET /health` | 200 (Fastify) | 200 (APIM short-circuit) | 200 | 200 |
| Everything else | 200 (NODE_ENV=development) | 401 (validate-jwt) | 401 | 200 / route response |

The `dev-apim (no token)` column is exactly the verification matrix the infra agent ran in commit `9c18182`. Use the same requests to spot-check after any APIM redeploy.

---

## When to update this collection

- **Backend ships a new endpoint** → add a `.bru` file under the matching folder + update [openapi.yaml](../../openapi.yaml) in the same PR.
- **APIM URL changes** (custom domain, new env) → update `environments/<env>.bru` only.
- **OAuth config changes** (tenant id, client id, scope) → update vars in `environments/dev-apim.bru` (the `collection.bru` references them by name and won't need editing).
- **Schemas change** (request body or response shape) → update the body block + asserts in the relevant `.bru` files.

---

## Quick reference card

```
Bruno OAuth 2.0 — ClearAI dev-apim
─────────────────────────────────────────────
Grant type:               Authorization Code
Callback:                 http://localhost
Authorization URL:        https://login.microsoftonline.com/{{tenantId}}/oauth2/v2.0/authorize
Access token URL:         https://login.microsoftonline.com/{{tenantId}}/oauth2/v2.0/token
Client ID:                {{cliClientId}}            (ClearAI CLI DEV)
Client Secret:            (empty — public client)
Scope:                    {{apiScope}} openid profile offline_access
Code Challenge Method:    SHA-256
Client Auth:              Send credentials in BODY  ← NOT Basic Auth header
Auto-fetch token:         Yes

Tenant:                   ef324fec-fecc-4c61-af6b-708bc4067e40    (Infinite Apps)
CLI client_id:            f2ed04f1-2889-440f-a8cb-52fd30ab6411    (ClearAI CLI DEV)
API app ID URI:           api://e39436da-d0ff-4923-8971-b4ec10300cfd
Scope value:              access_as_user
```

---

## CI / automation

Bruno has a `bru run` CLI that can drive this collection in CI:

```bash
npx -y @usebruno/cli run --env localhost
```

For `dev-apim` in CI, the OAuth flow needs adapting (browser-based auth-code+PKCE doesn't work headlessly). A client-credentials variant of the auth config would be the path; out of scope for this commit.
