-- =============================================================================
-- 008_api_p3_session_context.sql
--
-- Adds session-context columns to conversations and wellness_data to
-- session_summaries. Required by API-3 session-start and session-end
-- edge functions.
--
-- NOTE: 007 (007_caregiver_devices_platform_check) was applied directly to
-- the database during the API-P2 session and has no local file. The gap
-- in the file sequence is intentional and not a migration ordering hazard.
--
-- Changes:
--   conversations.trigger           — what initiated the session
--   conversations.reminder_id       — FK to reminders (SET NULL on delete)
--   conversations.adherence_log_id  — FK to adherence_log (SET NULL on delete)
--   session_summaries.wellness_data — arbitrary wellness JSON from agent
--
-- trigger has no CHECK constraint — validated at edge function layer for
-- flexibility as new trigger types are added.
-- Both FKs use SET NULL (not CASCADE) so deleting a reminder does not
-- delete the session record.
-- =============================================================================

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS trigger           text,
    ADD COLUMN IF NOT EXISTS reminder_id       uuid REFERENCES reminders(id)     ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS adherence_log_id  uuid REFERENCES adherence_log(id) ON DELETE SET NULL;

ALTER TABLE session_summaries
    ADD COLUMN IF NOT EXISTS wellness_data jsonb;
