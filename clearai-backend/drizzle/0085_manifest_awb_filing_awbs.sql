-- ============================================================================
-- 0085_manifest_awb_filing_awbs.sql
--
-- Introduces the manifest / AWB / filing-AWB hierarchy that mirrors ZATCA's
-- customs data model (NQM manifest → many AWBs → one declaration per AWB →
-- many items). PR2 is schema-only: tables are added, FK columns on
-- batch_items + batch_filings are added as NULLABLE, no backfill is
-- performed. PR3 will switch the parser to populate these columns from
-- Naqel's 25-column CSV and tighten the bundler to AWB-level HV/LV gating.
--
-- New tables:
--   manifests     — one row per MAWB (or per uploaded CSV when ManifestedTime
--                   is absent; generated id pattern {operator_slug}_m_{seqno})
--   awbs          — one row per HAWB / individual waybill; consignee identity
--                   lives here (national_id, name, mobile, address)
--   filing_awbs   — many-to-many join between batch_filings and awbs. HV
--                   filings have one row in the join; LV consolidated
--                   filings have many.
--
-- New columns:
--   batch_items.awb_id        — NULLABLE FK to awbs(id). NULL on legacy rows
--                               and on rows ingested before PR3 lands.
--   batch_filings.manifest_id — NULLABLE FK to manifests(id). NULL on legacy
--                               rows; set by PR3's bundler once a filing's
--                               parent manifest is known.
--
-- Cascade policy:
--   batches      ──< manifests      ON DELETE CASCADE   (delete a batch, delete its manifests)
--   manifests    ──< awbs           ON DELETE CASCADE
--   awbs         ──< batch_items    ON DELETE SET NULL  (preserve item, lose AWB link)
--   awbs         ──< filing_awbs    ON DELETE CASCADE   (filing_awbs is a join, not data)
--   batch_filings──< filing_awbs    ON DELETE CASCADE
--   manifests    ──< batch_filings  ON DELETE SET NULL  (preserve filing audit, lose manifest link)
--
-- Idempotent via IF NOT EXISTS. Re-running this file against a freshly
-- migrated DB is a no-op.
-- ============================================================================

-- ---------- manifests ----------

CREATE TABLE IF NOT EXISTS manifests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                uuid NOT NULL,

  -- The carrier-supplied master AWB number, e.g. "176-12345678". When the
  -- ingested CSV has no ManifestedTime / mawb_no, the parser synthesises an
  -- id of the form '{operator_slug}_m_{seqno}' (seqno scoped to the batch).
  -- Stored as text because Naqel sometimes uses non-numeric identifiers.
  mawb_no                 text NOT NULL,

  -- Carrier-supplied manifest timestamp, ISO 8601. NULL when the ingested
  -- CSV omits ManifestedTime — in that case the synthesised id is the only
  -- handle on the manifest.
  manifested_at           timestamptz,

  -- Optional flight/voyage metadata. NULL when the ingested CSV doesn't
  -- carry it. We don't constrain content; freeform for now.
  flight_no               text,
  arrival_date            date,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT manifests_batch_id_fk FOREIGN KEY (batch_id)
    REFERENCES batches(id) ON DELETE CASCADE,
  CONSTRAINT manifests_mawb_no_nonempty_chk CHECK (length(mawb_no) > 0)
);

CREATE INDEX IF NOT EXISTS manifests_batch_id_idx ON manifests (batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS manifests_batch_mawb_uniq ON manifests (batch_id, mawb_no);

DROP TRIGGER IF EXISTS manifests_touch_updated_at_trg ON manifests;
CREATE TRIGGER manifests_touch_updated_at_trg
  BEFORE UPDATE ON manifests
  FOR EACH ROW
  EXECUTE FUNCTION batches_touch_updated_at();

-- ---------- awbs ----------

CREATE TABLE IF NOT EXISTS awbs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id             uuid NOT NULL,

  -- The carrier-supplied house waybill number. Per Naqel's CSV this is the
  -- "WayBillNo" column. Required because one AWB = one consignee shipment =
  -- one ZATCA declaration. Stored as text (non-numeric ids are possible).
  awb_no                  text NOT NULL,

  -- Consignee identity. National ID is the canonical key per the
  -- 2026-05-18 customs spec discussion; nullable because Naqel CSVs
  -- occasionally omit it.
  consignee_national_id   text,
  consignee_name          text,
  consignee_mobile        text,
  consignee_phone         text,
  consignee_birth_date    date,
  consignee_address       text,
  consignee_dest          text,
  consignee_dest_station  text,

  -- Aggregated invoice value for the AWB in SAR, populated by PR3's
  -- bundler. The HV/LV gate (1000 SAR) is applied against this. NULL
  -- until bundler runs.
  invoice_value_sar       numeric(18, 4),

  -- Aggregated count of line items (= batch_items rows) under this AWB.
  -- NULL until bundler runs.
  line_item_count         integer,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT awbs_manifest_id_fk FOREIGN KEY (manifest_id)
    REFERENCES manifests(id) ON DELETE CASCADE,
  CONSTRAINT awbs_awb_no_nonempty_chk CHECK (length(awb_no) > 0),
  CONSTRAINT awbs_invoice_value_nonneg_chk CHECK (
    invoice_value_sar IS NULL OR invoice_value_sar >= 0
  ),
  CONSTRAINT awbs_line_item_count_nonneg_chk CHECK (
    line_item_count IS NULL OR line_item_count >= 0
  )
);

CREATE INDEX IF NOT EXISTS awbs_manifest_id_idx ON awbs (manifest_id);
CREATE UNIQUE INDEX IF NOT EXISTS awbs_manifest_awb_uniq ON awbs (manifest_id, awb_no);
CREATE INDEX IF NOT EXISTS awbs_consignee_national_id_idx ON awbs (consignee_national_id)
  WHERE consignee_national_id IS NOT NULL;

DROP TRIGGER IF EXISTS awbs_touch_updated_at_trg ON awbs;
CREATE TRIGGER awbs_touch_updated_at_trg
  BEFORE UPDATE ON awbs
  FOR EACH ROW
  EXECUTE FUNCTION batches_touch_updated_at();

-- ---------- batch_items.awb_id  (NULLABLE FK) ----------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'batch_items' AND column_name = 'awb_id'
  ) THEN
    ALTER TABLE batch_items ADD COLUMN awb_id uuid;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'batch_items_awb_id_fk'
  ) THEN
    ALTER TABLE batch_items
      ADD CONSTRAINT batch_items_awb_id_fk
      FOREIGN KEY (awb_id) REFERENCES awbs(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS batch_items_awb_id_idx ON batch_items (awb_id)
  WHERE awb_id IS NOT NULL;

-- ---------- batch_filings.manifest_id  (NULLABLE FK) ----------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'batch_filings' AND column_name = 'manifest_id'
  ) THEN
    ALTER TABLE batch_filings ADD COLUMN manifest_id uuid;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'batch_filings_manifest_id_fk'
  ) THEN
    ALTER TABLE batch_filings
      ADD CONSTRAINT batch_filings_manifest_id_fk
      FOREIGN KEY (manifest_id) REFERENCES manifests(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS batch_filings_manifest_id_idx ON batch_filings (manifest_id)
  WHERE manifest_id IS NOT NULL;

-- ---------- filing_awbs (many-to-many join) ----------

CREATE TABLE IF NOT EXISTS filing_awbs (
  filing_id  uuid NOT NULL,
  awb_id     uuid NOT NULL,

  -- Position of this AWB within the filing's render order (deterministic
  -- replay). 0-based. For HV filings (1 AWB per filing) this is always 0.
  -- For LV consolidated filings, this orders the AWBs that landed in the
  -- bundle so the rendered XML is reproducible.
  sequence   integer NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT filing_awbs_pkey PRIMARY KEY (filing_id, awb_id),
  CONSTRAINT filing_awbs_filing_id_fk FOREIGN KEY (filing_id)
    REFERENCES batch_filings(id) ON DELETE CASCADE,
  CONSTRAINT filing_awbs_awb_id_fk FOREIGN KEY (awb_id)
    REFERENCES awbs(id) ON DELETE CASCADE,
  CONSTRAINT filing_awbs_sequence_nonneg_chk CHECK (sequence >= 0)
);

CREATE INDEX IF NOT EXISTS filing_awbs_awb_id_idx ON filing_awbs (awb_id);
CREATE INDEX IF NOT EXISTS filing_awbs_filing_sequence_idx ON filing_awbs (filing_id, sequence);
