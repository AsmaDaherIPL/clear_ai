-- 0062_operators_zatca_submitter.sql
--
-- Move ZATCA submitter credentials out of env vars and onto the
-- operators row. These are per-operator identity-toward-ZATCA values,
-- siblings to the existing Tabadul/broker-license columns. Reading
-- them from env baked "Naqel only" into the running container; reading
-- them per-row scales to N operators without code changes.
--
-- Columns are nullable so existing rows don't break; the renderer
-- throws an operator-scoped error when an operator hits the XML
-- render path with these unset.

BEGIN;

ALTER TABLE operators
  ADD COLUMN zatca_submitter_carrier_id  varchar(32),
  ADD COLUMN zatca_submitter_name        text,
  ADD COLUMN zatca_declaration_namespace text;

COMMIT;
