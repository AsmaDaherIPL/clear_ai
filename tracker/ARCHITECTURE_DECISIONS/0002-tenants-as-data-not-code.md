# ADR-0002 — Tenant configuration is data, not code

Status: accepted, 2026-05-04
Scope: backend tenants module
Owner: backend platform

## Context

ClearAI is multi-tenant. Each carrier/broker (Naqel, future tenants) has:

- A different commercial-invoice CSV/XLSX shape — different column names,
  different value transforms, different optional/required fields.
- Different reference data — city → ZATCA-port mappings, currency code
  translations, country-of-origin codings, source-company port mappings,
  origin-client mappings (Naqel alone has 3,000+ such rows across 6 sheets).
- Different ZATCA Declaration envelope constants — carrier ID, submitter
  name, port codes that go into every XML for that tenant.
- Different bundling parameters — HV/LV split threshold, LV bundle size.

The naïve approach is one TypeScript module per tenant:

```
tenants/
  naqel/
    naqel.input-mapper.ts        // columns hard-coded in code
    naqel.constants.ts           // carrier ID hard-coded in code
    naqel.lookups.ts             // 3,000 lookup rows in a TS literal
```

This was on the table early in the design and was rejected.

## Decision

Tenant configuration lives entirely in the database. Five tables:

| Table | Holds |
|---|---|
| `tenants` | id, slug, display name, `bundle_size`, `hv_threshold_sar`, active flag |
| `tenant_field_mappings` | one row per (tenant, canonical field): source column, transform, required flag, default value |
| `tenant_constants` | one row per (tenant, key): fixed XML envelope values (carrier ID, submitter name, port codes) |
| `tenant_lookups` | one row per (tenant, lookup_type, source value): value translation tables (city, currency, country, port, etc.) |
| `tenant_code_overrides` | (pre-existing) per-tenant HS-code rewrite rules |

The codebase ships **one** generic mapper at
`src/modules/tenants/tenant-line-item.mapper.ts` that consumes mapping rows + lookup rows
and produces a `CanonicalLineItem`. There are no per-tenant TypeScript files.

The `src/modules/tenants/` folder contains:

- `tenant-config.types.ts` — `CanonicalLineItem`, `TenantConfig`, `ColumnMappingRule`
- `tenant.repository.ts` — Drizzle queries
- `tenant-config.registry.ts` — in-memory cache (resolve/refresh/warmAll/snapshot)
- `tenant.input-mapper.ts` (alias `tenant-line-item.mapper.ts`) — single generic mapper
- `tenant-lookups.repository.ts`, `tenant-constants.repository.ts` — read-only data accessors
- `tenants.routes.ts` — admin endpoints
- `tenant.errors.ts` — typed errors

## Consequences

**Onboarding a new tenant** =
1. INSERT one row in `tenants`.
2. INSERT N rows in `tenant_field_mappings` (one per canonical field).
3. INSERT M rows in `tenant_constants` (XML envelope fixed values).
4. INSERT lookup rows from the tenant's reference sheets.
5. POST `/tenants/:slug/refresh` to invalidate the in-memory cache.

Zero TypeScript edits. Zero deploys. Zero CI runs. A non-engineer with DB write
access can onboard a tenant.

## What this rules out

- Per-tenant business logic in TypeScript. Anything tenant-specific must be
  expressible as data; if it can't, the right move is to extend the schema
  (add a column, add a `transform` value, add a lookup_type), not to add a
  per-tenant code branch.
- Hot-loading a tenant config without DB write + cache refresh.
- Compile-time validation of tenant-specific values. Validation runs at
  registry-load time and is fail-closed (`MappingValidationError` halts boot
  if a tenant's mappings are invalid).

## What this trades away

- A new "transform" type (e.g. `iso8601_date`, `arabic_to_western_digits`)
  requires a code change to the generic mapper plus a migration to allow the
  new value in the `tenant_field_mappings.transform` CHECK constraint.
  Acceptable: transforms are a small finite set, and we'd rather centralise
  them than scatter per-tenant copies.

## Revisit triggers

- A tenant emerges with requirements impossible to express as data — e.g.
  multi-step conditional column derivation, business rules contingent on
  external API calls. At that point, consider a "tenant plugin" interface,
  not per-tenant folders.

## Memory pointer

(none — the decision IS the memory)
