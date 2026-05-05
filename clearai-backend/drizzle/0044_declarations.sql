-- ============================================================================
-- 0044_declarations.sql
--
-- One row per rendered ZATCA Declaration bundle. Phase 2 of the batch
-- pipeline (modules/batches/declaration/) inserts a row for every bundle
-- it produces — HV (one item) or LV (up to tenant.bundleSize items).
--
-- Why a dedicated table rather than a column on batches:
--   • A batch produces N declarations (1 per HV item + ceil(LV/bundleSize)).
--     The relation is genuinely one-to-many, not metadata.
--   • bayan_no is populated post-submission by Naqel; storing it on a
--     per-bundle row lets us track receipt status independently per bundle.
--   • blob_key is per bundle; the result_blob_key on batches is a v0
--     convenience pointer, not the source of truth.
--
-- What's safe:
--   • Idempotent (CREATE TABLE IF NOT EXISTS).
--   • No data migration.
--
-- What's intentionally not done:
--   • No status column on declarations yet. v1 will add submission state
--     (pending|submitted|accepted|rejected). v0 is "render + persist".
-- ============================================================================

CREATE TABLE IF NOT EXISTS declarations (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning batch. ON DELETE CASCADE — deleting a batch deletes its
  -- declaration rows.
  batch_id        uuid          NOT NULL,

  -- 0-based ordinal within the batch's render order.
  bundle_index    int           NOT NULL,

  -- Bundle strategy. CHECK-locked closed enum; mirror in TS BundleStrategy.
  bundle_strategy text          NOT NULL,

  -- Number of items rendered into this bundle. HV_STANDALONE = 1; LV_BUNDLED
  -- in [1, tenant.bundle_size].
  item_count      int           NOT NULL,

  -- Blob key under BATCH_BLOB_CONTAINER (e.g. batches/{batchId}/declarations/0001.xml).
  blob_key        text          NOT NULL,

  -- Receipt id from the carrier's submission of this declaration.
  -- Nullable: ClearAI hands the rendered XML to Naqel, who submits via
  -- ZATCA's portal and records the resulting Bayan number out-of-band.
  -- A future API integration will populate this column directly.
  bayan_no        text,

  created_at      timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT declarations_batch_fk
    FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,

  CONSTRAINT declarations_bundle_strategy_chk
    CHECK (bundle_strategy IN ('HV_STANDALONE', 'LV_BUNDLED')),

  CONSTRAINT declarations_bundle_index_nonneg_chk
    CHECK (bundle_index >= 0),

  CONSTRAINT declarations_item_count_pos_chk
    CHECK (item_count >= 1),

  -- HV bundles must hold exactly one item; LV bundles 1..*.
  CONSTRAINT declarations_strategy_count_consistency_chk
    CHECK (
      (bundle_strategy = 'HV_STANDALONE' AND item_count = 1)
      OR
      (bundle_strategy = 'LV_BUNDLED'    AND item_count >= 1)
    ),

  CONSTRAINT declarations_batch_bundle_uniq
    UNIQUE (batch_id, bundle_index)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS declarations_batch_idx
  ON declarations (batch_id);
--> statement-breakpoint
