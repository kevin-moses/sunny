-- =============================================================================
-- 003_device_tokens.sql
--
-- Adds device_tokens table for iOS/web push token storage used by
-- save-device-token Edge Function.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       text NOT NULL,
    platform    text NOT NULL CHECK (platform IN ('ios', 'web')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, platform)
);

DROP TRIGGER IF EXISTS device_tokens_updated_at ON device_tokens;

CREATE TRIGGER device_tokens_updated_at
    BEFORE UPDATE ON device_tokens
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'device_tokens'
          AND policyname = 'device_tokens_permissive'
    ) THEN
        CREATE POLICY device_tokens_permissive ON device_tokens
            FOR ALL USING (true) WITH CHECK (true);
    END IF;
END;
$$;
