-- ============================================================================
-- 0042_batches.sql
--
-- The batches table — one row per uploaded commercial-invoice file. Carries
-- the two-phase model from the BatchPlumber brief:
--
--   mode                    'classify_only' | 'classify_and_declare' (default)
--   classification_status   Phase 1 lifecycle: pending | running | completed | failed
--   declaration_status      Phase 2 lifecycle: pending | running | completed | failed | skipped
--                           NULL when mode = 'classify_only'
--   status                  derived overall lifecycle (kept materialised so polling
--                           is a single-column read, not a derivation)
--
-- The CHECK constraints lock all four enums. When any TS union gains a value,
-- a new migration must ALTER the CHECK; this is the explicit contract from
-- ADR-0009 / LESSONS_LEARNED.
--
-- The mode/declaration_status invariant
--   (mode = 'classify_only' AND declaration_status IS NULL) OR
--   (mode = 'classify_and_declare' AND declaration_status IS NOT NULL)
-- is enforced at the row level so we cannot end up with a 'classify_only'
-- batch that somehow has a declaration_status, or a 'classify_and_declare'
-- batch with NULL declaration_status.
--
-- What's safe:
--   • Idempotent (CREATE TABLE IF NOT EXISTS).
--   • No data migration.
--
-- What's intentionally not done:
--   • No partial index on (status) yet — query patterns will tell us which
--     status values get hot. Add index later, with EXPLAIN evidence, not
--     speculatively (rule 7).
--   • No FK from source_blob_key / result_blob_key to anywhere — blob
--     storage is external; the ref is just a string key.
-- ============================================================================

CREATE TABLE IF NOT EXISTS batches (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning tenant slug. FK to tenants(slug); ON DELETE RESTRICT (never
  -- silently destroy a tenant's batch history).
  tenant                  varchar(32)   NOT NULL,

  -- Two-phase mode. Default 'classify_and_declare' per the brief.
  mode                    varchar(32)   NOT NULL DEFAULT 'classify_and_declare',

  -- Derived overall lifecycle. Materialised (not a view) so polling reads
  -- a single column. Kept consistent by the application layer; the CHECK
  -- below ensures only valid values land here.
  status                  varchar(32)   NOT NULL DEFAULT 'pending',

  -- Phase 1 (classification) lifecycle. Always non-null.
  classification_status   varchar(32)   NOT NULL DEFAULT 'pending',

  -- Phase 2 (declaration) lifecycle. NULL iff mode = 'classify_only'.
  declaration_status      varchar(32),

  -- Blob keys (path under BATCH_BLOB_CONTAINER). Format documented in
  -- src/storage/blob.paths.ts: 'batches/{batchId}/input.{ext}' etc.
  source_blob_key         text          NOT NULL,
  result_blob_key         text,

  -- Total parsed rows, set at insert time after canonicalisation.
  row_count               integer       NOT NULL,

  -- Free-form jsonb metadata supplied at upload (callback url, original
  -- filename, etc.). Object-typed by CHECK to lock the read shape.
  metadata                jsonb         NOT NULL DEFAULT '{}'::jsonb,

  -- Last failure message (truncated by app layer). NULL on success.
  error                   text,

  created_at              timestamptz   NOT NULL DEFAULT now(),
  started_at              timestamptz,
  completed_at            timestamptz,
  updated_at              timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT batches_tenant_fk
    FOREIGN KEY (tenant) REFERENCES tenants(slug) ON DELETE RESTRICT,

  -- Defence-in-depth (the FK target's CHECK already enforces this; we keep
  -- it locally per the schema-rules contract that every tenant-scoped table
  -- carries the regex CHECK).
  CONSTRAINT batches_tenant_format_chk
    CHECK (tenant ~ '^[a-z][a-z0-9_]{2,31}$'),

  CONSTRAINT batches_mode_chk
    CHECK (mode IN ('classify_only', 'classify_and_declare')),

  CONSTRAINT batches_status_chk
    CHECK (status IN ('pending', 'ingesting', 'processing', 'completed', 'failed', 'cancelled')),

  CONSTRAINT batches_classification_status_chk
    CHECK (classification_status IN ('pending', 'running', 'completed', 'failed')),

  CONSTRAINT batches_declaration_status_chk
    CHECK (
      declaration_status IS NULL
      OR declaration_status IN ('pending', 'running', 'completed', 'failed', 'skipped')
    ),

  -- Mode/declaration_status invariant: classify_only -> NULL; otherwise non-null.
  CONSTRAINT batches_mode_declaration_consistency_chk
    CHECK (
      (mode = 'classify_only'        AND declaration_status IS NULL)
      OR
      (mode = 'classify_and_declare' AND declaration_status IS NOT NULL)
    ),

  CONSTRAINT batches_metadata_object_chk
    CHECK (jsonb_typeof(metadata) = 'object'),

  CONSTRAINT batches_row_count_nonneg_chk
    CHECK (row_count >= 0)
);
--> statement-breakpoint

-- B-tree on the FK column for tenant-scoped fan-out queries
-- ("all of naqel's batches in flight").
CREATE INDEX IF NOT EXISTS batches_tenant_idx
  ON batches (tenant);
--> statement-breakpoint

-- Created-at index for the admin dashboard's reverse-chronological listing.
CREATE INDEX IF NOT EXISTS batches_created_at_idx
  ON batches (created_at DESC);
--> statement-breakpoint

DROP TRIGGER IF EXISTS batches_touch_updated_at_trg ON batches;
--> statement-breakpoint

-- Reuses batches_touch_updated_at() defined in 0038.
CREATE TRIGGER batches_touch_updated_at_trg
  BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION batches_touch_updated_at();
--> statement-breakpoint
