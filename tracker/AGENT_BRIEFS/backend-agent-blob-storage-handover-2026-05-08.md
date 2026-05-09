# Backend agent handover — Azure Blob Storage for declaration runs (2026-05-08)

**From:** infra agent
**To:** backend agent
**Status:** Storage account provisioned, RBAC granted, ready for backend wiring.

---

## What was provisioned

| Field | Value |
|---|---|
| Storage account | `stinfpclearaidevgwc01` |
| Resource group | `rg-infp-clearai-common-dev-gwc-01` |
| Region | `germanywestcentral` |
| SKU | `Standard_LRS`, `StorageV2`, Hot tier |
| Blob endpoint | `https://stinfpclearaidevgwc01.blob.core.windows.net/` |
| Container | `declaration-runs` (private; `publicAccess: None`) |
| Lifecycle | Auto-delete blobs under `declaration-runs/` after 90 days |
| Soft delete | Blobs and containers: 7 days |

### Security posture (read this carefully — it changes how you connect)

- `allowSharedKeyAccess = false` — **no connection strings, no shared keys**. Any code path that tries to construct a connection string with an account key will fail.
- `allowBlobPublicAccess = false` — no anonymous reads even if a container were public.
- `publicNetworkAccess = Disabled` — the blob endpoint is unreachable from the internet. Reachable from:
  - Container App (Microsoft trusted services bypass — works automatically over the Azure backbone)
  - Azure Portal (also trusted)
  - **Not** from your laptop or the SPA in the user's browser
- Auth = **Entra ID only**. Backend authenticates with the Container App's system-assigned MI. SPA never touches storage directly — it goes through your APIM endpoints, which return either streamed bytes or short-lived user-delegation SAS URLs.

### RBAC already wired

The Container App's system-assigned managed identity (principalId `04516458-cdf4-4ebf-862c-b0c9d7c5e37c`) has **Storage Blob Data Contributor** at the storage-account scope. That role grants:

- `read`, `write`, `delete` on blobs
- `getUserDelegationKey` (the API needed to mint user-delegation SAS URLs)

So you do NOT need a separate `Storage Blob Delegator` role — Data Contributor covers both.

The same MI already has Key Vault Secrets User on `kv-infp-clearai-dev-gwc` — same MI, two roles, two services.

---

## Container App env vars to add

Add these to `clearai-backend/infra/modules/containerapp.bicep` in the `env` array on the container, then redeploy the Container App. They're plain strings (not secretrefs — no secrets to source from KV).

```bicep
{ name: 'BATCH_BLOB_BACKEND',   value: 'azure-blob' }
{ name: 'BATCH_BLOB_ACCOUNT',   value: 'stinfpclearaidevgwc01' }
{ name: 'BATCH_BLOB_CONTAINER', value: 'declaration-runs' }
```

Do **NOT** add `BATCH_BLOB_CONNECTION` or any `*_KEY` / `*_CONNECTION_STRING` variant. The Azure Storage SDK will use `DefaultAzureCredential`, which on Container Apps resolves to the system-assigned MI automatically.

For local dev (`docker-compose`), keep using the `file://./.local-blob/` driver. The `BATCH_BLOB_BACKEND` env var is the toggle: `file` locally, `azure-blob` in the deployed Container App.

---

## SDK setup

Use `@azure/storage-blob` and `@azure/identity`. Both are already in the dependency tree as transitive deps via `@azure/keyvault-secrets`, but add them explicitly:

```bash
pnpm --filter clearai-backend add @azure/storage-blob @azure/identity
```

Wiring:

```typescript
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

const account = process.env.BATCH_BLOB_ACCOUNT!;       // stinfpclearaidevgwc01
const containerName = process.env.BATCH_BLOB_CONTAINER!; // declaration-runs

const blobServiceClient = new BlobServiceClient(
  `https://${account}.blob.core.windows.net`,
  new DefaultAzureCredential()
);

const containerClient = blobServiceClient.getContainerClient(containerName);
```

`DefaultAzureCredential` chain: in the Container App it picks up the system-assigned MI; locally it falls back to `az login` credentials (which will fail until your IP is whitelisted on the storage firewall — keep using the file driver locally).

---

## Blob key layout

Use forward-slash hierarchical naming. The container `declaration-runs/` does NOT need a flat namespace — `/` in blob names just renders as folders in the Portal browser.

Convention (operator slug is hardcoded `naqel` for now — see "Open issue: ownership" below):

```
naqel/{YYYY}/{MM}/{DD}/{declaration_run_id}/
  manifest.json
  hv/{filing_id}.xml
  hv/{filing_id}.xml
  lv/{filing_id}.xml
  lv/{filing_id}.xml
  ...
```

Example for run `aa11bb22-...` created on 2026-05-08:

```
naqel/2026/05/08/aa11bb22-cccc-dddd-eeee-ff0011223344/manifest.json
naqel/2026/05/08/aa11bb22-cccc-dddd-eeee-ff0011223344/hv/filing-001.xml
naqel/2026/05/08/aa11bb22-cccc-dddd-eeee-ff0011223344/lv/filing-002.xml
```

Path padding rules:
- Year: 4 digits (`YYYY`)
- Month: zero-padded 2 digits (`05` not `5`)
- Day: zero-padded 2 digits (`08` not `8`)
- Run ID: full UUID (no truncation)
- Filing ID: whatever your DB row's `filing_id` is — use the same string

The container name `declaration-runs` is already fixed by infra. Don't include it in the key — the SDK takes container and key separately.

---

## Endpoints to build

### 1. Write path

When the dispatch pipeline produces XML for a run, write to blob:

- HV bundle XMLs → `naqel/{YYYY}/{MM}/{DD}/{run_id}/hv/{filing_id}.xml`
- LV chunk XMLs → `naqel/{YYYY}/{MM}/{DD}/{run_id}/lv/{filing_id}.xml`
- Run manifest → `naqel/{YYYY}/{MM}/{DD}/{run_id}/manifest.json`

The manifest.json is your own format — at minimum: `{ "runId", "operatorSlug", "createdAt", "files": [{ "type": "hv|lv", "filingId", "blobKey", "sizeBytes", "contentType" }] }`.

Suggested DB column: persist the run's blob prefix on `declaration_runs`:

```sql
ALTER TABLE declaration_runs
  ADD COLUMN blob_prefix TEXT;  -- e.g. "naqel/2026/05/08/aa11bb22-..."
```

That way you don't have to recompute the date partition from `created_at` later (timezone footguns).

### 2. Read path A — multi-file SAS download (recommended)

`GET /declaration-runs/{id}/download-links`

```typescript
// Pseudocode
async function getDownloadLinks(runId: string, req: Request) {
  // Auth check (currently a no-op until the OID column lands — see "Open issue")
  const run = await db.query('SELECT id, blob_prefix FROM declaration_runs WHERE id = $1', [runId]);
  if (!run) return 404;

  // List blobs under the run's prefix
  const blobs = [];
  for await (const blob of containerClient.listBlobsFlat({ prefix: run.blob_prefix })) {
    blobs.push(blob);
  }

  // Get a user-delegation key (valid for up to 7 days; we use 5 min)
  const startsOn = new Date(Date.now() - 5 * 60 * 1000); // 5 min skew
  const expiresOn = new Date(Date.now() + 5 * 60 * 1000);
  const userDelegationKey = await blobServiceClient.getUserDelegationKey(startsOn, expiresOn);

  // Sign one SAS URL per blob (read-only)
  const files = blobs.map((b) => {
    const sasOptions = {
      containerName,
      blobName: b.name,
      permissions: BlobSASPermissions.parse('r'),
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
    };
    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      userDelegationKey,
      account
    ).toString();
    return {
      name: b.name.replace(`${run.blob_prefix}/`, ''), // relative path within run
      url: `https://${account}.blob.core.windows.net/${containerName}/${b.name}?${sasToken}`,
      sizeBytes: b.properties.contentLength,
      contentType: b.properties.contentType,
    };
  });

  return { runId, expiresAt: expiresOn.toISOString(), files };
}
```

The SPA will receive a JSON list of `{ name, url, sizeBytes, contentType }` and either show download links, fetch each file in parallel, or zip them client-side (JSZip).

### 2. Read path B — single-file stream-through (for direct downloads)

`GET /declaration-runs/{id}/files/*`

For simple cases — e.g. preview a single XML in the SPA — stream from blob through the backend:

```typescript
const downloadResp = await containerClient.getBlobClient(blobKey).download();
reply.type(downloadResp.contentType ?? 'application/xml');
reply.header('content-disposition', `attachment; filename="${path.basename(blobKey)}"`);
return reply.send(downloadResp.readableStreamBody);
```

Use this for previews, single-file downloads, debug endpoints. Use SAS for "download all files for this run" — saves Container App CPU.

---

## OpenAPI updates

After implementing, add the new endpoints to `clearai-backend/openapi.yaml`. APIM will redeploy automatically on next infra run because that file is `loadTextContent`-imported.

Suggested additions (sketch):

```yaml
/declaration-runs/{id}/download-links:
  get:
    operationId: getDeclarationRunDownloadLinks
    summary: Get short-lived download URLs for all files in a declaration run
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    security: [{ entraJwt: ['api://e39436da-d0ff-4923-8971-b4ec10300cfd/access_as_user'] }]
    responses:
      '200':
        description: List of short-lived download URLs (5 min expiry)
        content:
          application/json:
            schema:
              type: object
              properties:
                runId: { type: string, format: uuid }
                expiresAt: { type: string, format: date-time }
                files:
                  type: array
                  items:
                    type: object
                    properties:
                      name: { type: string, example: hv/filing-001.xml }
                      url: { type: string, format: uri }
                      sizeBytes: { type: integer }
                      contentType: { type: string }
      '404': { $ref: '#/components/responses/NotFound' }

/declaration-runs/{id}/files/{path}:
  get:
    operationId: getDeclarationRunFile
    summary: Stream a single file from a declaration run through the backend
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      - { name: path, in: path, required: true, schema: { type: string, example: hv/filing-001.xml } }
    security: [{ entraJwt: ['api://e39436da-d0ff-4923-8971-b4ec10300cfd/access_as_user'] }]
    responses:
      '200': { description: File bytes (XML or JSON), content: { '*/*': {} } }
      '404': { $ref: '#/components/responses/NotFound' }
```

Quote the `entraJwt: ['api://...']` strings — APIM's OpenAPI 3.1 validator chokes on unquoted URI colons in YAML flow sequences (we hit this before).

---

## Open issue: per-user ownership (defer, not block)

**Today there is no user-ownership column on `declaration_runs`.** Any authenticated ClearAI user can read any run's blobs by guessing IDs. This is acceptable for dev (solo developer) but must be fixed before second-user prod.

When you're ready, the smallest viable fix is:

```sql
ALTER TABLE declaration_runs
  ADD COLUMN created_by_oid TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  ADD COLUMN created_by_email TEXT,
  ADD COLUMN created_by_name TEXT;
CREATE INDEX idx_declaration_runs_created_by ON declaration_runs(created_by_oid);
```

Plus a Fastify preHandler that:
1. Re-validates the JWT (defense in depth — APIM already did it but trust-but-verify)
2. Extracts `oid`, `email`, `name` from claims
3. Attaches as `req.user`

Then on `POST /declaration-runs` persist `created_by_oid = req.user.oid`. On every blob read endpoint: `WHERE id = $1 AND created_by_oid = $2`. If no row → return 404 (don't leak existence with 403).

This is a separate task. Don't block the storage wiring on it. The infra is ready; the auth gap is a known dev-only acceptable risk.

The `naqel` operator slug in the path is also a placeholder. When you onboard a second operator, add an `operators` table, a `users.operator_id` FK, and replace the hardcoded `'naqel'` with `req.user.operator.slug`. The path layout is forward-compatible.

---

## Local development

Don't try to use the Azure Storage account from your laptop. Public network access is disabled and your IP isn't on the firewall. Keep using the existing file driver:

```bash
# .env.local
BATCH_BLOB_BACKEND=file
BATCH_BLOB_FILE_ROOT=./.local-blob
```

If you ever NEED to inspect dev blobs from your laptop, temporarily add your IP:

```bash
IP=$(curl -s https://api.ipify.org)
az storage account network-rule add \
  --account-name stinfpclearaidevgwc01 \
  --resource-group rg-infp-clearai-common-dev-gwc-01 \
  --ip-address $IP

# Then change publicNetworkAccess temporarily:
az storage account update \
  --name stinfpclearaidevgwc01 \
  --resource-group rg-infp-clearai-common-dev-gwc-01 \
  --public-network-access Enabled

# When done, lock it back down:
az storage account update \
  --name stinfpclearaidevgwc01 \
  --resource-group rg-infp-clearai-common-dev-gwc-01 \
  --public-network-access Disabled
```

For routine work this is overkill — read blobs through the Container App's debug endpoints instead.

---

## Verification (after backend wiring)

```bash
# 1. Confirm the Container App env vars are set
az containerapp show -g rg-infp-clearai-common-dev-gwc-01 -n ca-infp-clearai-be-dev-gwc-01 \
  --query "properties.template.containers[0].env[?starts_with(name, 'BATCH_BLOB_')]" -o table

# 2. Trigger a run that produces XML output and check blob landed
TOKEN="$(az account get-access-token --resource api://e39436da-d0ff-4923-8971-b4ec10300cfd --query accessToken -o tsv)"
curl -i -X POST "https://apim-infp-clearai-be-dev-gwc-01.azure-api.net/declaration-runs" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@sample.csv"
# Note the runId from the response

# 3. Get download links
curl -s "https://apim-infp-clearai-be-dev-gwc-01.azure-api.net/declaration-runs/{runId}/download-links" \
  -H "Authorization: Bearer $TOKEN" | jq

# 4. Download one of the files via the SAS URL
curl -i "<the url from step 3>"
# Expected: 200 with XML content. SAS URL is valid for ~5 min.
```

Smoke check via Portal: open the storage account → Storage browser → declaration-runs container. You should see the `naqel/2026/05/08/{runId}/...` tree appear after a run.

---

## Cost expectation

At dev volumes (single-digit GB, hot tier, LRS, lifecycle deletion at 90 days, soft delete 7 days): well under $1/month. Storage transactions are roughly $0.005 per 10,000 — negligible.

---

## Definition of done (backend agent)

- [ ] `@azure/storage-blob` and `@azure/identity` added to `clearai-backend/package.json`
- [ ] `BlobStore` interface gets an `azure-blob` driver implementation alongside the existing `file` driver
- [ ] `BATCH_BLOB_BACKEND`, `BATCH_BLOB_ACCOUNT`, `BATCH_BLOB_CONTAINER` env vars added to `containerapp.bicep` and Container App revision restarted
- [ ] Dispatch pipeline writes manifest + HV + LV XMLs to blob using the documented key layout
- [ ] `GET /declaration-runs/{id}/download-links` endpoint returns SAS URLs for all files in the run
- [ ] `GET /declaration-runs/{id}/files/*` endpoint streams single files (optional but nice for previews)
- [ ] OpenAPI YAML updated with the two endpoints; APIM redeploys cleanly
- [ ] Verification curls (above) pass on dev
- [ ] DB column `blob_prefix` added to `declaration_runs` (suggested but not required)

## Out of scope (separate tasks)

- Per-user ownership column + filter middleware
- Operator/tenant model (operators table, users.operator_id FK)
- ZIP-everything endpoint (the SPA can JSZip client-side from the SAS URLs)
- Production storage account (separate Bicep param + GRS + versioning)
- Long-term archive policy (move to cool/archive tier instead of delete)
