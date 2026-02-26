-- =============================================================================
-- 005_profile_summary.sql
--
-- Two schema additions:
--
--   1. users.profile_summary (text)
--      Replaces the fragmented user_facts key-value approach with a single
--      free-text prose paragraph written by Claude at session end. Updated
--      each session via UPDATE users SET profile_summary = ... instead of
--      individual upsert_user_fact RPC calls.
--
--   2. workflows.senior_description (text)
--      Plain-English description of a workflow written for older adults.
--      Used by the iOS app for display and by the ingestion script as the
--      preferred embedding text (more natural language than 'description').
--
--   3. get_user_context() is replaced to include profile_summary in the
--      profile jsonb object returned to the agent at session start.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add profile_summary column to users
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_summary text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- 2. Add senior_description column to workflows
-- ---------------------------------------------------------------------------
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS senior_description text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- 3. Replace get_user_context to include profile_summary in profile object
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_user_context(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_profile    jsonb;
    v_facts      jsonb;
    v_summaries  jsonb;
    v_reminders  jsonb;
BEGIN
    -- User profile (now includes profile_summary)
    SELECT jsonb_build_object(
        'name',            name,
        'ios_version',     ios_version,
        'timezone',        timezone,
        'profile_summary', profile_summary
    )
    INTO v_profile
    FROM users
    WHERE id = p_user_id;

    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'User % not found', p_user_id;
    END IF;

    -- Active facts grouped by category (kept for session_summaries.extracted_facts,
    -- no longer used in the system prompt directly)
    SELECT COALESCE(
        jsonb_object_agg(
            category,
            facts
        ),
        '{}'::jsonb
    )
    INTO v_facts
    FROM (
        SELECT
            category,
            jsonb_object_agg(key, value ORDER BY key) AS facts
        FROM user_facts
        WHERE user_id = p_user_id
          AND valid_until IS NULL
        GROUP BY category
    ) grouped;

    -- Last 5 session summaries
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'conversation_id',  ss.conversation_id,
                'summary',          ss.summary,
                'extracted_facts',  ss.extracted_facts,
                'flagged_concerns', ss.flagged_concerns,
                'created_at',       ss.created_at
            )
            ORDER BY ss.created_at DESC
        ),
        '[]'::jsonb
    )
    INTO v_summaries
    FROM (
        SELECT ss.*
        FROM session_summaries ss
        JOIN conversations c ON c.id = ss.conversation_id
        WHERE c.user_id = p_user_id
        ORDER BY ss.created_at DESC
        LIMIT 5
    ) ss;

    -- All active reminders
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id',          id,
                'type',        type,
                'title',       title,
                'description', description,
                'schedule',    schedule,
                'timezone',    timezone
            )
            ORDER BY created_at
        ),
        '[]'::jsonb
    )
    INTO v_reminders
    FROM reminders
    WHERE user_id = p_user_id
      AND active = true;

    RETURN jsonb_build_object(
        'profile',   v_profile,
        'facts',     v_facts,
        'summaries', v_summaries,
        'reminders', v_reminders
    );
END;
$$;

GRANT EXECUTE ON FUNCTION get_user_context(uuid) TO authenticated, service_role;
