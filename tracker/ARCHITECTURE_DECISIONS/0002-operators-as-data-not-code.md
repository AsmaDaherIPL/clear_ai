# ADR-0002 — Operator configuration is data, not code

Status: accepted, 2026-05-04
Scope: backend operators module
Owner: backend platform

## Context

ClearAI is multi-operator. Each carrier/broker (Naqel, future operators) has:

- A different commercial-invoice CSV/XLSX shape — different column names,
  different value transforms, different optional/required fields.
- Different reference data — city → ZATCA-port mappings, currency code
  translations, country-of-origin codings, source-company port mappings,
  origin-client mappings (Naqel alone has 3,000+ such rows across 6 sheets).
- Different ZATCA Declaration envelope constants — carrier ID, submitter
  name, port codes that go into every XML for that operator.
- Different bundling parameters — HV/LV split threshold, LV bundle size.

The naïve approach is one TypeScript module per operator:

```
operators/
  naqel/
    naqel.input-mapper.ts        // columns hard-coded in code
    naqel.constants.ts           // carrier ID hard-coded in code
    naqel.lookups.ts             // 3,000 lookup rows in a TS literal
```

This was on the table early in the design and was rejected.

## Decision

Operator configuration lives entirely in the database. Five tables:

| Table | Holds |
|---|---|
| `operators` | id, slug, display name, `bundle_size`, `hv_threshold_sar`, active flag |
| `tenant_field_mappings` | one row per (operator, canonical field): source column, transform, required flag, default value |
| `tenant_constants` | one row per (operator, key): fixed XML envelope values (carrier ID, submitter name, port codes) |
| `tenant_lookups` | one row per (operator, lookup_type, source value): value translation tables (city, currency, country, port, etc.) |
| `tenant_code_overrides` | (pre-existing) per-operator HS-code rewrite rules |

The codebase ships **one** generic mapper at
`src/modules/operators/operator-line-item.mapper.ts` that consumes mapping rows + lookup rows
and produces a `CanonicalLineItem`. There are no per-operator TypeScript files.

The `src/modules/operators/` folder contains:

- `operator-config.types.ts` — `CanonicalLineItem`, `TenantConfig`, `ColumnMappingRule`
- `operator.repository.ts` — Drizzle queries
- `operator-config.registry.ts` — in-memory cache (resolve/refresh/warmAll/snapshot)
- `operator.input-mapper.ts` (alias `operator-line-item.mapper.ts`) — single generic mapper
- `operator-lookups.repository.ts`, `operator-constants.repository.ts` — read-only data accessors
- `operators.routes.ts` — admin endpoints
- `operator.errors.ts` — typed errors

## Consequences

**Onboarding a new operator** =
1. INSERT one row in `operators`.
2. INSERT N rows in `tenant_field_mappings` (one per canonical field).
3. INSERT M rows in `tenant_constants` (XML envelope fixed values).
4. INSERT lookup rows from the operator's reference sheets.
5. POST `/operators/:slug/refresh` to invalidate the in-memory cache.

Zero TypeScript edits. Zero deploys. Zero CI runs. A non-engineer with DB write
access can onboard a operator.

## What this rules out

- Per-operator business logic in TypeScript. Anything operator-specific must be
  expressible as data; if it can't, the right move is to extend the schema
  (add a column, add a `transform` value, add a lookup_type), not to add a
  per-operator code branch.
- Hot-loading a operator config without DB write + cache refresh.
- Compile-time validation of operator-specific values. Validation runs at
  registry-load time and is fail-closed (`MappingValidationError` halts boot
  if a operator's mappings are invalid).

## What this trades away

- A new "transform" type (e.g. `iso8601_date`, `arabic_to_western_digits`)
  requires a code change to the generic mapper plus a migration to allow the
  new value in the `tenant_field_mappings.transform` CHECK constraint.
  Acceptable: transforms are a small finite set, and we'd rather centralise
  them than scatter per-operator copies.

## Revisit triggers

- A operator emerges with requirements impossible to express as data — e.g.
  multi-step conditional column derivation, business rules contingent on
  external API calls. At that point, consider a "operator plugin" interface,
  not per-operator folders.

## Memory pointer

(none — the decision IS the memory)
