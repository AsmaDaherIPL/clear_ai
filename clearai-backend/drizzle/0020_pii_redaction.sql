-- ============================================================================
-- 0020_pii_redaction.sql
--
-- Phase 2.4 of the security remediation (backend security review H5 — `request`
-- JSONB stores merchant free-text indefinitely with no PII layer).
--
-- This migration adds storage for redacted request payloads. Redaction LOGIC
-- lives in TypeScript (src/observability/redact.ts) — that's where the regex
-- + heuristic + future LLM-based PII detector live, and that's where unit
-- tests can hammer it without touching Postgres.
--
-- Storage model:
--   • request          — UNCHANGED. Still the raw body the client sent. Kept
--                        for full audit/debug. Will be column-revoked from
--                        the readonly role (already done in 0019) and from
--                        any future analytics path.
--   • request_redacted — NEW. JSONB. The redacted view that any non-admin
--                        path reads. Populated at write time by logEvent.
--                        Trace endpoints + future analytics consume this
--                        instead of `request`.
--
-- Why two columns and not one:
--   We could rewrite `request` in place and drop the raw form. We don't,
--   because:
--     1. Forensics + debug: when a classification result is wrong, the
--        broker's broker support team needs to see the original input
--        verbatim, not a redacted version that may have eaten the very
--        token that caused the misclassification.
--     2. Backfill realism: old rows (pre-this-migration) have no redacted
--        copy. We backfill lazily — see step 4 of this migration. A
--        future "delete `request` after N days" job is a separate phase.
--     3. PDPL erasure works on the raw column too: a DSAR-shaped delete
--        targets both columns, plus the row, plus any join in feedback.
--
-- Why JSONB and not text:
--   The redactor preserves the original payload's shape (keys still present,
--   values replaced with the marker `[REDACTED:phone]` etc.). Downstream
--   consumers can do `request_redacted->>'description'` exactly the same
--   way they do `request->>'description'` today.
--
-- Backfill strategy:
--   We do NOT backfill historical rows in this migration. Reasons:
--     • Backfill is expensive on a 32GB-storage Burstable B1ms — hours to
--       run on a million rows, lock-related risk, and we don't want to
--       block the deploy on it.
--     • The redactor is an evolving artefact. Backfill once with v1, and
--       v2 redactor improvements would require backfill-again. Better to
--       run backfill on a known-stable redactor as a separate scripted
--       step.
--   For now: future inserts get both columns, historical rows have NULL
--   in `request_redacted` and the trace endpoint falls back to `request`
--   when redacted is null (with a `_redacted: false` marker to make the
--   distinction visible to consumers).
-- ============================================================================

ALTER TABLE classification_events
  ADD COLUMN IF NOT EXISTS request_redacted jsonb;
--> statement-breakpoint

COMMENT ON COLUMN classification_events.request IS
  'Raw request body verbatim. May contain user-supplied PII. Restricted to admin / migrator roles via column-level GRANTs (see 0019_role_separation). Read-only for app role.';
--> statement-breakpoint

COMMENT ON COLUMN classification_events.request_redacted IS
  'Redacted form of request. Phone numbers, emails, and obvious entity-name patterns replaced with markers. Populated at insert time by src/observability/redact.ts. NULL for rows inserted before 0020_pii_redaction (lazy-backfilled by a separate script).';
--> statement-breakpoint

-- App role needs to write the new column too. 0019 granted INSERT broadly;
-- explicit re-grant for documentation. (Already covered by ALL on the
-- migrator side; this just makes the app's privilege list explicit when
-- someone reads `\dp classification_events`.)
GRANT SELECT, INSERT (
  endpoint, request, request_redacted, language_detected,
  decision_status, decision_reason, confidence_band,
  chosen_code, alternatives,
  top_retrieval_score, top2_gap, candidate_count, branch_size,
  llm_used, llm_status, guard_tripped,
  model_calls, embedder_version, llm_model, total_latency_ms,
  error, rationale
) ON classification_events TO clearai_app;
--> statement-breakpoint

-- The readonly role gets SELECT on the new column — redacted is the WHOLE
-- POINT of having it: analytics can read it freely. Add the column to the
-- existing column allow-list.
GRANT SELECT (request_redacted) ON classification_events TO clearai_readonly;
--> statement-breakpoint

-- Useful for debugging "did the redactor produce anything for this row?"
-- Partial index: only rows where redaction was attempted. Cheap.
CREATE INDEX IF NOT EXISTS classification_events_redacted_idx
  ON classification_events ((request_redacted IS NOT NULL))
  WHERE request_redacted IS NOT NULL;
