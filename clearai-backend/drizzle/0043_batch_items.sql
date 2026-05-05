-- ============================================================================
-- 0043_batch_items.sql
--
-- One row per parsed line item under a batch. Phase 1 (classification) reads
-- pending rows, calls dispatch(item), and writes the result back into
-- classification_result + final_code + trace + status.
--
-- Why final_code is promoted to a top-level column (not just inside
-- classification_result jsonb):
--   • FKs can't bind to a jsonb path; CHECKs can't cross-table-read.
--   • Promoting it lets us FK to zatca_hs_codes(code) ON DELETE RESTRICT,
--     which is the schema-rules contract for any column referencing a SABER
--     ZATCA code: a deletion that would orphan a classification fails loudly.
--   • The column is NULL while the row is pending/classifying/failed/blocked
--     — final_code only lands when dispatch() returns a successful result.
--
-- Why canonical and raw_row are SEPARATE jsonb columns:
--   • The verbatim parsed source row carries PII (consignee names, national
--     IDs, phone numbers from Naqel's commercial-invoice xlsx). Embedding it
--     inside `canonical` would force every operational read of canonical to
--     drag the PII out wholesale.
--   • Splitting it lets us apply column-level GRANT/REVOKE to raw_row alone
--     (mirrors the 0019_role_separation.sql pattern). The analytics role
--     can SELECT canonical without ever seeing raw_row.
--   • Future redaction routines operate on raw_row directly via an in-place
--     UPDATE — no parsing of nested jsonb required.
--   • Trace consumers that need both still get them with one row read:
--     `SELECT canonical, raw_row FROM batch_items WHERE id = $1`.
--
-- The status enum is CHECK-locked. When you add a TS value, ALTER the CHECK.
--
-- What's safe:
--   • Idempotent (CREATE TABLE IF NOT EXISTS).
--   • No data migration.
--
-- What's intentionally not done:
--   • No FK from canonical (jsonb) to anywhere — it's the verbatim mapped
--     CanonicalLineItem, opaque to the DB.
--   • No GIN on canonical/classification_result/trace yet — no query path
--     filters by jsonb keys today (rule 7: don't index "just in case").
-- ============================================================================

CREATE TABLE IF NOT EXISTS batch_items (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent batch. ON DELETE CASCADE — deleting a batch deletes its items
  -- (matches the rule-4 contract for batch tables).
  batch_id              uuid          NOT NULL,

  -- 1-based row position from the source file (post-header). UNIQUE per
  -- (batch_id, row_index) so retries don't accidentally duplicate rows.
  row_index             integer       NOT NULL,

  -- Mapped CanonicalLineItem as jsonb. Opaque to the DB; the app reads the
  -- typed CanonicalLineItem off this column. Contains canonicalised,
  -- mapper-output fields ONLY — no verbatim source row, no PII.
  canonical             jsonb         NOT NULL,

  -- Verbatim parsed source row (CSV/XLSX cell strings, or API-supplied raw
  -- object). Contains PII; access is gated by the column-level GRANT below.
  -- This is the source-of-truth for re-running canonicalisation if the
  -- mapper rules ever change.
  raw_row               jsonb         NOT NULL,

  -- Phase 1 lifecycle. CHECK-locked.
  status                varchar(32)   NOT NULL DEFAULT 'pending',

  -- Final 12-digit ZATCA HS code from dispatch().finalCode.
  -- Nullable because the column is populated only when status reaches
  -- 'succeeded' or 'flagged' — pending/classifying/failed/blocked rows
  -- have no final code yet. FK to zatca_hs_codes(code) ON DELETE RESTRICT
  -- so a SABER deletion of a code that's been used in a classification
  -- fails loudly rather than silently orphaning the result.
  final_code            char(12),

  -- Full dispatch() result payload (path taken, alternates, signals, etc.).
  -- Opaque jsonb; the trace column carries the per-stage detail.
  classification_result jsonb,

  -- ItemTrace from dispatch(). Object-typed by CHECK.
  -- NULL while the item is still pending/classifying — first writeable
  -- value is whatever dispatch() returns.
  trace                 jsonb,

  -- Last failure message; NULL on success.
  error                 text,

  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT batch_items_batch_fk
    FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,

  CONSTRAINT batch_items_final_code_fk
    FOREIGN KEY (final_code) REFERENCES zatca_hs_codes(code) ON DELETE RESTRICT,

  CONSTRAINT batch_items_status_chk
    CHECK (status IN ('pending', 'classifying', 'succeeded', 'flagged', 'blocked', 'failed')),

  CONSTRAINT batch_items_row_index_nonneg_chk
    CHECK (row_index >= 1),

  CONSTRAINT batch_items_canonical_object_chk
    CHECK (jsonb_typeof(canonical) = 'object'),

  CONSTRAINT batch_items_raw_row_object_chk
    CHECK (jsonb_typeof(raw_row) = 'object'),

  CONSTRAINT batch_items_classification_result_object_chk
    CHECK (classification_result IS NULL OR jsonb_typeof(classification_result) = 'object'),

  CONSTRAINT batch_items_trace_object_chk
    CHECK (trace IS NULL OR jsonb_typeof(trace) = 'object'),

  -- final_code mirrors zatca_hs_codes.code format; documented locally so
  -- a malformed value can't be inserted even if the FK is dropped/disabled.
  CONSTRAINT batch_items_final_code_format_chk
    CHECK (final_code IS NULL OR final_code ~ '^[0-9]{12}$'),

  -- final_code may only be present when the item actually succeeded /
  -- flagged. blocked / failed rows must not carry a final_code; pending /
  -- classifying must not either.
  CONSTRAINT batch_items_final_code_status_consistency_chk
    CHECK (
      (status IN ('succeeded', 'flagged') AND final_code IS NOT NULL)
      OR
      (status NOT IN ('succeeded', 'flagged') AND final_code IS NULL)
    ),

  CONSTRAINT batch_items_batch_row_uniq
    UNIQUE (batch_id, row_index)
);
--> statement-breakpoint

-- Composite (batch_id, row_index) covers two hot read paths:
--   1. WHERE batch_id = $1                    (leftmost-prefix btree lookup)
--   2. WHERE batch_id = $1 ORDER BY row_index (index scan satisfies ORDER BY,
--                                              no in-memory sort)
-- A single-column (batch_id) index would force Postgres to sort after the
-- scan; for batches with thousands of items that's measurable. The composite
-- is free at table-creation time so we pay the cost once.
CREATE INDEX IF NOT EXISTS batch_items_batch_row_idx
  ON batch_items (batch_id, row_index);
--> statement-breakpoint

-- Hot-path partial index for the Phase 1 worker's claimNextItem query
-- (SELECT ... WHERE batch_id = $1 AND status = 'pending' ...).
CREATE INDEX IF NOT EXISTS batch_items_pending_idx
  ON batch_items (batch_id)
  WHERE status = 'pending';
--> statement-breakpoint

-- B-tree on final_code for "which items resolved to this code?" lookups
-- and to support the FK-backed cascade-restrict check at delete time.
CREATE INDEX IF NOT EXISTS batch_items_final_code_idx
  ON batch_items (final_code)
  WHERE final_code IS NOT NULL;
--> statement-breakpoint

DROP TRIGGER IF EXISTS batch_items_touch_updated_at_trg ON batch_items;
--> statement-breakpoint

-- Reuses batches_touch_updated_at() defined in 0038.
CREATE TRIGGER batch_items_touch_updated_at_trg
  BEFORE UPDATE ON batch_items
  FOR EACH ROW EXECUTE FUNCTION batches_touch_updated_at();
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Role-separation grants (mirrors 0019_role_separation.sql pattern).
--
-- The application role gets full table-level access. The analytics role
-- (clearai_readonly) gets column-level SELECT on every column EXCEPT
-- raw_row — which carries PII from the source upload (consignee names,
-- national IDs, phone numbers).
--
-- Defensive guards: in dev/test environments the roles may not exist
-- (only 0019 creates them, and that migration has additional Key Vault
-- preconditions). The DO block skips the GRANT/REVOKE when a role is
-- missing rather than failing the migration.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_app') THEN
    GRANT SELECT, INSERT, UPDATE ON batch_items TO clearai_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearai_readonly') THEN
    -- Grant SELECT on every non-PII column. Listed explicitly so a future
    -- column addition forces an explicit GRANT decision (fail-closed).
    GRANT SELECT (
      id, batch_id, row_index,
      canonical,
      status, final_code,
      classification_result, trace, error,
      created_at, updated_at
      -- intentionally NOT granted: raw_row (PII).
    ) ON batch_items TO clearai_readonly;
  END IF;
END
$$;
--> statement-breakpoint
