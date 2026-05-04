-- ============================================================================
-- 0019_role_separation.sql
--
-- Phase 2.1 of the security remediation (backend security review H3 — single
-- super-user, no RLS, no schema isolation).
--
-- Today every connection from the app, the migrator, and any future analytics
-- consumer uses `clearai_admin` — the Postgres super-user. One bug =
-- `DROP TABLE`. This migration carves out three least-privilege roles:
--
--   • clearai_app         — what the running Fastify app uses.
--                           SELECT/INSERT/UPDATE on the data tables.
--                           SELECT on the catalog tables.
--                           NO DDL. NO truncate. NO ability to read pg_authid
--                           or any other role's secrets. NO schema-create.
--   • clearai_migrator    — what `migrate-and-start.ts` uses to apply DDL.
--                           Full DDL on public + (later) pii / catalog
--                           schemas. Used only at process start; the running
--                           app never holds this credential.
--   • clearai_readonly    — for future analytics + dashboards. SELECT-only
--                           on observability rows EXCLUDING the raw `request`
--                           column (which carries free-text user input).
--                           Not wired up by any code today; carving it now
--                           so the future analytics consumer doesn't need
--                           a follow-up migration.
--
-- Cutover plan (per ADR for this change, see tracker/ARCHITECTURE_DECISIONS.md):
--   1. This migration RUNS the first time as clearai_admin (the existing
--      DATABASE_URL still points at the admin). It creates the three roles,
--      grants their privileges, and sets default-privilege rules so future
--      tables created by the migrator are auto-granted to the app role.
--   2. Operator updates Key Vault: adds `postgres-app-connection-string`
--      (pointing at clearai_app) and `postgres-migrator-connection-string`
--      (pointing at clearai_migrator). Sets the app role's password.
--   3. Container App revision updates env: DATABASE_URL → app conn-string;
--      MIGRATOR_DATABASE_URL → migrator conn-string. The migrator script
--      reads MIGRATOR_DATABASE_URL when set, falls back to DATABASE_URL
--      for backwards compatibility (the first deploy of this migration).
--   4. The OLD admin connection-string in KV stays as a break-glass secret
--      for one release cycle, then gets deleted (per Phase 3 plan — the
--      admin role itself goes away in Phase 3.5 when Postgres flips to
--      Entra auth and the personal-MI break-glass replaces it).
--
-- Why three roles and not two:
--   The split between app and migrator is the load-bearing security
--   boundary (the running app cannot mutate schema). The third (readonly)
--   exists because it's the simplest moment to add it — every future
--   "give analytics a read-only view" request would otherwise require
--   another migration round-trip and another KV secret rotation.
--
-- Why this isn't an idempotency-broken migration:
--   `CREATE ROLE` is not idempotent in vanilla SQL — re-running it raises
--   42710. We DO IT inside a DO block with conditional `pg_roles` lookup,
--   making the migration idempotent (Drizzle's ledger means it won't be
--   re-run on the same DB anyway, but local re-creates from a fresh DB
--   plus an explicit `pnpm db:migrate` second-run shouldn't error).
--
-- Why we set passwords here:
--   We DON'T. Postgres requires the password to be set out-of-band so it
--   doesn't appear in the migration source-controlled in git. deploy.sh
--   reads/generates passwords from Key Vault and runs an `ALTER ROLE`
--   step against the DB after the migration applies. The roles are
--   created with `LOGIN` but no usable password until then; without a
--   password they cannot connect.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create the three roles (idempotent — DO block conditional on pg_roles)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_app') THEN
    CREATE ROLE clearai_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
    COMMENT ON ROLE clearai_app IS 'Application role used by the running Fastify backend. Read/write on data tables, read-only on catalog. No DDL.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_migrator') THEN
    CREATE ROLE clearai_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
    COMMENT ON ROLE clearai_migrator IS 'Migrator role used only by migrate-and-start.ts at boot. Full DDL on the public/pii/catalog schemas.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_readonly') THEN
    CREATE ROLE clearai_readonly WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
    COMMENT ON ROLE clearai_readonly IS 'Read-only analytics role. SELECT on non-PII columns only. No write, no DDL.';
  END IF;
END
$$;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 2. Database-level CONNECT
-- ----------------------------------------------------------------------------
-- All three roles need `CONNECT` on the database. By default `public` (the
-- pseudo-role every role inherits from) has it on Azure-flavoured Postgres,
-- but we make it explicit for clarity and because `REVOKE CONNECT FROM PUBLIC`
-- is a defence-in-depth move other operators sometimes apply post-hoc.

GRANT CONNECT ON DATABASE clearai TO clearai_app;
GRANT CONNECT ON DATABASE clearai TO clearai_migrator;
GRANT CONNECT ON DATABASE clearai TO clearai_readonly;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 3. Schema USAGE
-- ----------------------------------------------------------------------------
-- Roles can name objects in the `public` schema only after USAGE is granted.
-- Migrator gets CREATE so it can `CREATE TABLE` etc. App + readonly do not —
-- the running app cannot create new tables even if a SQL injection bug
-- existed and tried to.

GRANT USAGE  ON SCHEMA public TO clearai_app;
GRANT USAGE, CREATE ON SCHEMA public TO clearai_migrator;
GRANT USAGE  ON SCHEMA public TO clearai_readonly;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 4. Per-table privileges — app role
-- ----------------------------------------------------------------------------
-- Data tables (the rows the app actively writes during request handling):
--   classification_events   — INSERT (logEvent), SELECT (trace endpoint)
--   classification_feedback — INSERT/UPDATE (UPSERT in the feedback route),
--                              SELECT (trace endpoint reads feedback rows)
-- Catalog tables (read-only by the app):
--   hs_codes, procedure_codes, broker_code_mapping, setup_meta
--
-- We do NOT grant DELETE on classification_events / feedback. Deletion is a
-- DSAR-shaped operation that should go through a scoped admin path, not the
-- running app. (See backend security review H5 / Phase 2 plan — DSAR
-- endpoints land separately and use a different role with explicit DELETE.)

GRANT SELECT, INSERT          ON classification_events   TO clearai_app;
GRANT SELECT, INSERT, UPDATE  ON classification_feedback TO clearai_app;

GRANT SELECT ON hs_codes              TO clearai_app;
GRANT SELECT ON procedure_codes       TO clearai_app;
-- broker_code_mapping is created in 0012; setup_meta in 0000.
GRANT SELECT ON broker_code_mapping   TO clearai_app;
GRANT SELECT ON setup_meta            TO clearai_app;

-- Sequences for SERIAL / bigserial / nextval()-using inserts. Today every
-- table uses gen_random_uuid() (no sequences for primary keys), but defensive
-- in case a future table introduces one.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clearai_app;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 5. Per-table privileges — migrator
-- ----------------------------------------------------------------------------
-- Migrator gets ALL on every existing table + sequence + function in public.
-- The CREATE on schema (above) covers new objects; the ALTER DEFAULT
-- PRIVILEGES below ensures objects the migrator creates are usable by the
-- app role automatically.

GRANT ALL ON ALL TABLES    IN SCHEMA public TO clearai_migrator;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO clearai_migrator;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO clearai_migrator;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 6. Per-table privileges — readonly
-- ----------------------------------------------------------------------------
-- SELECT-only on the observability tables EXCLUDING the columns that carry
-- raw user-supplied free-text. Postgres column-level GRANTs are the right
-- tool here. The excluded columns: `request` (free-text classifications),
-- `error` (driver errors / stack-trimmed messages may contain user input),
-- `rationale` (picker free-text — minor risk of containing parts of the
-- description).
--
-- Catalog tables are entirely public-information and get full SELECT.

GRANT SELECT (
  id, created_at, endpoint, language_detected,
  decision_status, decision_reason, confidence_band,
  chosen_code, alternatives,
  top_retrieval_score, top2_gap, candidate_count, branch_size,
  llm_used, llm_status, guard_tripped,
  model_calls, embedder_version, llm_model, total_latency_ms
  -- intentionally NOT granted: request, error, rationale
) ON classification_events TO clearai_readonly;

GRANT SELECT (
  id, created_at, updated_at, event_id, kind,
  rejected_code, corrected_code, user_id
  -- intentionally NOT granted: reason (free-text)
) ON classification_feedback TO clearai_readonly;

GRANT SELECT ON hs_codes            TO clearai_readonly;
GRANT SELECT ON procedure_codes     TO clearai_readonly;
GRANT SELECT ON broker_code_mapping TO clearai_readonly;
GRANT SELECT ON setup_meta          TO clearai_readonly;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 7. Default privileges for future tables
-- ----------------------------------------------------------------------------
-- When the migrator (acting as clearai_migrator) creates a new table later,
-- this rule auto-grants SELECT/INSERT/UPDATE to the app role. Without this
-- every new migration would have to remember to GRANT — which someone will
-- forget once and only realise after a 503 in production.
--
-- The grantor for ALTER DEFAULT PRIVILEGES is whoever runs this migration
-- — first deploy = clearai_admin. We set FOR USER clearai_migrator
-- explicitly so the rule applies to objects the migrator creates from the
-- second deploy onward (when this migration runs as clearai_admin via the
-- old DATABASE_URL, but future migrations run as clearai_migrator via the
-- new MIGRATOR_DATABASE_URL).

ALTER DEFAULT PRIVILEGES FOR USER clearai_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO clearai_app;

ALTER DEFAULT PRIVILEGES FOR USER clearai_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO clearai_app;

ALTER DEFAULT PRIVILEGES FOR USER clearai_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO clearai_readonly;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 8. Re-grant to the existing admin (no-op if you ARE the admin)
-- ----------------------------------------------------------------------------
-- This migration is run as clearai_admin (the super-user). super-users
-- bypass GRANTs entirely, so no extra privilege is needed for them. We
-- DON'T grant the new roles TO clearai_admin — that would let a compromised
-- admin connection rotate-impersonate the lesser roles, exactly the blast
-- radius we're trying to reduce. (Postgres super-users CAN `SET ROLE` to
-- anyone anyway, so this is a moot point operationally; we just don't
-- formalise it.)

-- ----------------------------------------------------------------------------
-- 9. Self-test (logged via NOTICE; visible in migration output)
-- ----------------------------------------------------------------------------
-- Confirms the three roles exist after this migration. Cheap and useful
-- when debugging "why is the app 503-ing on connect" after a partial
-- deploy.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('clearai_app', 'clearai_migrator', 'clearai_readonly') ORDER BY 1 LOOP
    RAISE NOTICE '[0019_role_separation] role exists: %', r.rolname;
  END LOOP;
END
$$;
