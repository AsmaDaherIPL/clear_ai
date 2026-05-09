-- Replace description_classifier_chosen_code + description_classifier_confidence
-- with description_classifier_top_fit_code (highest-RRF candidate verdicted 'fits').
--
-- Historical rows: chosen_code is preserved inside trace jsonb; the top-level
-- column is dropped. description_classifier_confidence was a hardcoded 0.8 constant
-- and carries no analytical value, so it is dropped without backfill.

ALTER TABLE classification_events
  DROP COLUMN IF EXISTS description_classifier_chosen_code,
  DROP COLUMN IF EXISTS description_classifier_confidence,
  ADD COLUMN description_classifier_top_fit_code varchar(12);
