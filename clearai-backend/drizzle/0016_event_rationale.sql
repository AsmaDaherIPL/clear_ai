-- ============================================================================
-- 0016_event_rationale.sql
--
-- Persist the picker's plain-English rationale on classification_events so the
-- trace page (GET /trace/:eventId) can render *why* a code was chosen, not just
-- *what* was chosen. The picker already returns a `rationale: string | null`
-- field in LlmPickResult; previously we shipped it on the response but never
-- wrote it to the event row, which meant it was lost the moment the user
-- closed the tab. Trace-replay was only as informative as the structured fields.
--
-- Nullable: existing rows stay NULL; routes that don't have a rationale
-- (best-effort fallback, degraded path) write NULL too. No CHECK constraint
-- because the value is free text capped to 500 chars upstream by the picker.
-- ============================================================================

ALTER TABLE classification_events
  ADD COLUMN IF NOT EXISTS rationale text;
--> statement-breakpoint
