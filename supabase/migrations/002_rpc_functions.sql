-- =============================================================================
-- 002_rpc_functions.sql
--
-- Helper RPC functions for the Sunny agent. All functions use SECURITY DEFINER
-- so they run with the privileges of the defining role, not the caller.
-- GRANTed to both `authenticated` and `service_role`.
--
-- Functions:
--   get_user_context        - Load full user context at session start
--   upsert_user_fact        - Insert or replace a user fact (preserving history)
--   get_due_reminders       - Return reminders due within 1 minute of check_time
--   mark_reminder_triggered - Update last_triggered on a reminder
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. get_user_context(p_user_id uuid) RETURNS jsonb
--
-- Returns a single JSON object containing:
--   - profile:   name, ios_version, timezone
--   - facts:     all active facts grouped by category
--   - summaries: last 5 session summaries (most recent first)
--   - reminders: all active reminders
--
-- Called once at agent session start to build the system prompt context block.
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
    -- User profile
    SELECT jsonb_build_object(
        'name',        name,
        'ios_version', ios_version,
        'timezone',    timezone
    )
    INTO v_profile
    FROM users
    WHERE id = p_user_id;

    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'User % not found', p_user_id;
    END IF;

    -- Active facts grouped by category
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
                'conversation_id', ss.conversation_id,
                'summary',         ss.summary,
                'extracted_facts', ss.extracted_facts,
                'flagged_concerns', ss.flagged_concerns,
                'created_at',      ss.created_at
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

-- ---------------------------------------------------------------------------
-- 2. upsert_user_fact(p_user_id, p_category, p_key, p_value, p_conversation_id)
--    RETURNS void
--
-- Soft-updates a user fact to preserve temporal history:
--   1. Expire the current active fact (set valid_until = now()) if one exists.
--   2. Insert a new row with valid_from = now().
--
-- This means old values remain queryable for historical context.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_user_fact(
    p_user_id          uuid,
    p_category         text,
    p_key              text,
    p_value            text,
    p_conversation_id  uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Expire any currently active fact with this user+category+key
    UPDATE user_facts
    SET    valid_until = now()
    WHERE  user_id    = p_user_id
      AND  category   = p_category
      AND  key        = p_key
      AND  valid_until IS NULL;

    -- Insert the new fact
    INSERT INTO user_facts (user_id, category, key, value, valid_from, source_conversation_id)
    VALUES (p_user_id, p_category, p_key, p_value, now(), p_conversation_id);
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_user_fact(uuid, text, text, text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. get_due_reminders(p_check_time timestamptz) RETURNS SETOF reminders
--
-- Returns active reminders that are due at p_check_time, where:
--   - The reminder's timezone day-of-week matches a day in schedule->'days'
--   - The current time (in reminder timezone) is within 1 minute of any
--     time listed in schedule->'times'
--   - It has not been triggered in the last 30 minutes (to prevent duplicates)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_due_reminders(p_check_time timestamptz)
RETURNS SETOF reminders
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_reminder  reminders%ROWTYPE;
    v_local_ts  timestamp;  -- current time in reminder's timezone (no tz)
    v_sched_ts  timestamp;  -- scheduled time in reminder's timezone (no tz)
    v_dow       text;
    v_time_str  text;
BEGIN
    FOR v_reminder IN
        SELECT * FROM reminders WHERE active = true
    LOOP
        -- AT TIME ZONE on a timestamptz returns timestamp (without tz) in that zone
        v_local_ts := p_check_time AT TIME ZONE v_reminder.timezone;

        -- Day-of-week abbreviation in the reminder's timezone (e.g. 'sun')
        v_dow := lower(to_char(v_local_ts, 'Dy'));

        -- Skip if today is not in the schedule's days list
        CONTINUE WHEN NOT (
            v_dow = ANY(
                ARRAY(SELECT jsonb_array_elements_text(v_reminder.schedule->'days'))
            )
        );

        -- Check each scheduled time
        FOR v_time_str IN
            SELECT jsonb_array_elements_text(v_reminder.schedule->'times')
        LOOP
            -- Build scheduled timestamp in the same timezone context (both without tz)
            -- so the subtraction gives the true elapsed seconds in local time
            v_sched_ts := date_trunc('day', v_local_ts) + v_time_str::time;

            IF abs(extract(epoch FROM (v_local_ts - v_sched_ts))) <= 60 THEN
                IF v_reminder.last_triggered IS NULL
                   OR v_reminder.last_triggered < p_check_time - interval '30 minutes'
                THEN
                    RETURN NEXT v_reminder;
                    EXIT;  -- Only emit this reminder once even if multiple times match
                END IF;
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION get_due_reminders(timestamptz) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. mark_reminder_triggered(p_reminder_id uuid) RETURNS void
--
-- Sets last_triggered = now() for the given reminder after it fires.
-- Called by the reminder scheduler after a notification is sent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_reminder_triggered(p_reminder_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE reminders
    SET    last_triggered = now()
    WHERE  id = p_reminder_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reminder % not found', p_reminder_id;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_reminder_triggered(uuid) TO authenticated, service_role;
