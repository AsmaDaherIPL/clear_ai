# Backend agent handover — download endpoint authorisation (Layer B)

**From:** infra agent
**To:** backend agent
**Date:** 2026-05-09
**Status:** Layer A shipped (immediate hardening). Layer B requires backend changes — handing over.
**Severity:** P2 (multi-tenant data leak risk; mitigated, not eliminated)

---

## Background

Code review flagged that the two blob-download endpoints look up runs by UUID
only, with no operator/user authorisation check. Any caller with a valid Entra
JWT and a known `declaration_run_id` can pull SAS URLs for that run's
`input.csv` (raw commercial-invoice data: HS codes, values, consignee names,
mobile numbers, national IDs).

Routes:
- `GET /declaration-runs/:id/download-links`
- `GET /declaration-runs/:id/files/*`

File: `src/modules/declaration-runs/declaration-runs.routes.ts`

---

## What infra already shipped (Layer A — already deployed)

**Commit:** TBD (this batch)

1. **UUIDv7-only ID schema.** Replaced `z.string().uuid()` (accepts v1/v4/v7)
   with a strict UUIDv7 regex. UUIDv7 has 74 random bits in the entropy
   region; blind guessing is computationally infeasible. Sequential
   enumeration is also infeasible.
2. **Path-traversal guard tightened.** `'..'` already rejected. Added
   rejection of leading `/` and `\` to block alternative bypass shapes.
3. **In-code documentation.** Added a long comment block (lines 82–127 of
   the routes file) describing the gap and pointing here.

This does not stop a determined attacker who exfiltrates a real run id
through other channels (logs, screenshots, another bug). It just removes the
"guess the URL" attack vector.

---

## What you need to do (Layer B)

### 1. Schema change

New Drizzle migration (next number — likely 0062):

```sql
ALTER TABLE declaration_runs
  ADD COLUMN created_by_oid text NULL;

CREATE INDEX idx_declaration_runs_created_by_oid
  ON declaration_runs (created_by_oid)
  WHERE created_by_oid IS NOT NULL;
```

Decision needed: backfill behaviour. Two options:

| Option | Behaviour | Pros | Cons |
|---|---|---|---|
| A. Leave NULL | Existing rows: anyone can download (matches current behaviour) | No data migration, no risk of mis-attribution | Legacy rows stay leaky; need a deprecation date |
| B. Stamp owner | Backfill `created_by_oid = '<asma_oid>'` for all existing dev rows | All rows scoped from day one | Wrong if other people created runs (check `pipeline_events.actor_oid` if it exists) |

Recommend **A** for dev (no real PII at risk, all rows are test data) with a
backend log message "WARN: legacy run downloaded without owner check" so we
can tell when the last legacy row is touched, then drop the NULL allowance
in a follow-up migration.

### 2. JWT verification middleware

The backend currently trusts the APIM shared-secret as the only auth signal
(`src/server/app.ts:59-77`). The Authorization header is forwarded by APIM
but never parsed by the backend. You need:

- A new module `src/auth/jwt.middleware.ts` that:
  - Reads `Authorization: Bearer ...` from the request
  - Verifies the signature against the Entra JWKS endpoint
    (`https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`)
    — cache the JWKS for 24h (jose library does this for free)
  - Validates `aud`, `iss`, `exp`, `nbf`
  - Attaches `req.user = { oid, preferred_username, scp }` on success
  - On failure: 401 (don't fall through silently — APIM should have caught
    it but defence in depth)
- A Fastify plugin that registers the middleware as an `onRequest` hook
  AFTER the existing shared-secret check, scoped only to routes that need
  user identity. Probes (`/health`, `/ready`) and the upload route stay
  exempt initially — see step 3.

Use the `jose` library (already in `package.json` — `pnpm list jose` to
confirm). It handles JWKS rotation, alg pinning, and clock skew.

Tenant id and audience values are already in `env.ts` — they're the same
values APIM uses (`api://e39436da-...`).

### 3. Route changes

**POST /declaration-runs** (controller: `declaration-run.controller.ts:103`):
- After multipart parse, read `req.user.oid` and pass it through to
  `handleCreateDeclarationRun` → `dispatch` → repository insert.
- Persist on `declaration_runs.created_by_oid`.

**GET /declaration-runs/:id/download-links** and **GET /:id/files/***:
- Add `AND (created_by_oid = $2 OR created_by_oid IS NULL)` to the SELECT
  during the deprecation window. Drop the IS NULL clause when the legacy
  rows are gone.
- If `req.user` is missing (middleware was never attached) → 500 with a
  clear log message; don't silently allow.

**Admin bypass:**
- Define a config var `ADMIN_OIDS` (comma-separated, from KV).
- If `req.user.oid` is in `ADMIN_OIDS`, skip the ownership filter.
- For dev: stamp your own oid (`1a350e42-18e1-4334-8ac9-8700ecbd4e37`) so
  you can review any run without the SPA dance.

### 4. Tests

Currently zero route-level tests exist for the download endpoints
(`tests/declaration-runs/` has parser/use-case tests only). Add at least:

- `download-links.routes.test.ts`
  - 401 when no Authorization header
  - 401 when JWT is invalid
  - 400 when id is not UUIDv7 (already enforced by Layer A)
  - 404 when run id doesn't exist
  - 404 when run exists but `created_by_oid` doesn't match `req.user.oid`
    (the pretend-it-doesn't-exist response — DON'T return 403)
  - 200 when oid matches
  - 200 when caller is in `ADMIN_OIDS`

Use Fastify's `app.inject()` for these — no live PG/blob needed if the
controller is structured to take a repository interface.

### 5. SPA impact

The SPA already sends the JWT in `Authorization: Bearer ...` for every API
call (MSAL → APIM → backend forward). No SPA change needed *if* you keep
the route shapes the same and only add the implicit ownership filter. The
SPA UX changes only when a user tries to access someone else's run id —
they'll see "not found" instead of the data, which is correct.

### 6. Documentation

After Layer B lands:
- Update the long comment block in `declaration-runs.routes.ts` (lines
  82-127) — strike out the "Layer B (separate task)" section and replace
  with "Layer B shipped in <commit-sha>".
- Append to `clearai-backend/CLAUDE.md` under the security section.
- Reply to the original code review thread closing P2 #3.

---

## Recommended sequence

```
day 1 — half day
  - [ ] Migration 0062 (created_by_oid)
  - [ ] jose-based JWT middleware + tests
  - [ ] Apply middleware as onRequest hook scoped to /declaration-runs/*
day 2 — half day
  - [ ] Stamp created_by_oid in POST handler
  - [ ] Add ownership filter to both download endpoints
  - [ ] ADMIN_OIDS config + KV secret
  - [ ] Route-level tests
  - [ ] Manual smoke from SPA + Bruno
  - [ ] Update routes file comment + CLAUDE.md
```

Single deploy at the end. Before flipping to production, do a paranoid
review of the JWT verification (this is the highest-stakes new code on the
backend).

---

## Out of scope for this brief

- Per-operator scope check (caller's `oid → operators[]` map). Not needed
  while ClearAI is single-operator (`naqel` only). Add when the second
  operator lands.
- Audit logging of every download (separate observability task).
- SAS URL revocation (Azure doesn't support it cleanly; mitigate via the
  short 5-min TTL we already have).
- CSV-row-level redaction. Out of scope; downloads return the run's
  artifacts as-is.

---

## Done definition

Reply with:
- Commit SHA / PR number
- `psql` output: `\d declaration_runs` showing `created_by_oid` column
- Paste of the 7 test cases listed in step 4 (PASS)
- One screenshot or curl output showing a 404 when a different user's
  oid tries to access a run id they don't own
