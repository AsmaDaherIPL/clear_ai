-- ============================================================================
-- 0031_procedures_array_duty_struct.sql
--
-- Two structural data-model upgrades on hs_codes (ADR-0025 follow-up):
--
--   A. procedures: text → text[]
--      The column today stores comma-joined strings like "61,98". Querying
--      "which codes require procedure X?" needed string parsing every time.
--      With text[] we get `WHERE 61 = ANY(procedures)` natively + a GIN
--      index for set membership.
--
--   B. duty_en + duty_ar (text) → duty_rate_pct numeric(5,2) + duty_status text
--      ZATCA's xlsx duty cell holds either a percentage rate ("5 %", "6.5 %")
--      OR a status word ("Exempted", "Prohibited from Importing",
--      "Prohibited from Exporting", "Prohibited from Exporting and Importing").
--      Today every API request re-parses the raw string. After this
--      migration the parsed shape is persisted once at ingest:
--        duty_rate_pct  — numeric % when status='rate', else NULL
--        duty_status    — enum-string: 'rate' | 'exempted'
--                         | 'prohibited_import' | 'prohibited_export'
--                         | 'prohibited_both'  (NULL if no duty data)
--      Per ADR-0025 commit C decision: we do NOT keep raw_en/raw_ar — the
--      parsed shape is what brokers need, and the verbatim ZATCA string
--      is recoverable from the xlsx if ever needed for audit.
-- ============================================================================

-- ─── A. procedures column → text[] ──────────────────────────────────────────

ALTER TABLE hs_codes ADD COLUMN procedures_arr text[];
--> statement-breakpoint

UPDATE hs_codes
   SET procedures_arr = string_to_array(
         regexp_replace(coalesce(procedures, ''), '\s+', '', 'g'),  -- strip whitespace
         ','
       )
 WHERE procedures IS NOT NULL AND procedures <> '';
--> statement-breakpoint

-- Drop empty-string artefacts: string_to_array('', ',') returns {''} on
-- some PG versions; clean these up to NULL.
UPDATE hs_codes
   SET procedures_arr = NULL
 WHERE procedures_arr = '{}'::text[]
    OR procedures_arr = ARRAY[''];
--> statement-breakpoint

ALTER TABLE hs_codes DROP COLUMN procedures;
--> statement-breakpoint

ALTER TABLE hs_codes RENAME COLUMN procedures_arr TO procedures;
--> statement-breakpoint

-- GIN index for "find codes requiring procedure X" (rare today but cheap).
CREATE INDEX IF NOT EXISTS hs_codes_procedures_gin
  ON hs_codes USING gin (procedures);
--> statement-breakpoint

-- ─── B. duty_en/duty_ar → duty_rate_pct + duty_status ───────────────────────

ALTER TABLE hs_codes
  ADD COLUMN duty_rate_pct numeric(5,2),
  ADD COLUMN duty_status text;
--> statement-breakpoint

-- Backfill from duty_en. Logic mirrors src/catalog/duty-info.ts so the
-- one-time DB parse matches what the route was doing at request time.
UPDATE hs_codes
   SET duty_rate_pct =
         CASE
           WHEN duty_en ~ '^\s*\d+(\.\d+)?\s*%\s*$'
             THEN regexp_replace(duty_en, '[^\d.]', '', 'g')::numeric(5,2)
           ELSE NULL
         END,
       duty_status =
         CASE
           WHEN duty_en IS NULL OR btrim(duty_en) = '' THEN NULL
           WHEN duty_en ~ '^\s*\d+(\.\d+)?\s*%\s*$' THEN 'rate'
           WHEN lower(btrim(duty_en)) = 'exempted' THEN 'exempted'
           WHEN lower(btrim(duty_en)) = 'prohibited from importing' THEN 'prohibited_import'
           WHEN lower(btrim(duty_en)) = 'prohibited from exporting' THEN 'prohibited_export'
           WHEN lower(btrim(duty_en)) = 'prohibited from exporting and importing' THEN 'prohibited_both'
           ELSE NULL  -- unknown status word; leave NULL so route returns null duty rather than guess
         END;
--> statement-breakpoint

-- Constraint: duty_rate_pct is non-null IFF duty_status='rate'.
ALTER TABLE hs_codes
  ADD CONSTRAINT hs_codes_duty_consistency_chk CHECK (
    (duty_status = 'rate'                     AND duty_rate_pct IS NOT NULL) OR
    (duty_status IN ('exempted','prohibited_import','prohibited_export','prohibited_both')
                                              AND duty_rate_pct IS NULL) OR
    (duty_status IS NULL                      AND duty_rate_pct IS NULL)
  );
--> statement-breakpoint

-- Drop the now-redundant raw text columns.
ALTER TABLE hs_codes
  DROP COLUMN duty_en,
  DROP COLUMN duty_ar;
--> statement-breakpoint
