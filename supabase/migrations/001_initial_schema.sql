-- =============================================================================
-- 001_initial_schema.sql
--
-- Core schema for Sunny voice agent. Creates all tables required for:
--   - User profiles and persistent memory (user_facts)
--   - Conversation session records and individual message turns
--   - Scheduled reminders with JSONB schedule config
--   - Post-session AI-generated summaries
--
-- RLS is enabled on all tables with permissive policies for now.
-- TODO (Phase 3): Tighten RLS policies with real auth (JWT-based user_id check).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    ios_version text,
    timezone    text NOT NULL DEFAULT 'America/New_York',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Keep updated_at current on every row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_permissive ON users
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at  timestamptz NOT NULL DEFAULT now(),
    ended_at    timestamptz,
    summary     text,
    sentiment   text,
    topics      text[],
    status      text NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_started
    ON conversations(user_id, started_at DESC);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversations_permissive ON conversations
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content         text NOT NULL,
    timestamp       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp
    ON messages(conversation_id, timestamp);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_permissive ON messages
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. reminders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            text NOT NULL CHECK (type IN ('medication', 'appointment', 'exercise', 'wellness_checkin', 'custom')),
    title           text NOT NULL,
    description     text,
    schedule        jsonb NOT NULL,
    timezone        text NOT NULL DEFAULT 'America/New_York',
    active          boolean NOT NULL DEFAULT true,
    last_triggered  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reminders_user_active
    ON reminders(user_id, active);

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY reminders_permissive ON reminders
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 5. user_facts  (persistent key-value memory per user)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_facts (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category              text NOT NULL CHECK (category IN ('medication', 'health', 'preference', 'personal', 'device')),
    key                   text NOT NULL,
    value                 text NOT NULL,
    valid_from            timestamptz NOT NULL DEFAULT now(),
    valid_until           timestamptz,
    source_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_facts_user_category
    ON user_facts(user_id, category);

-- Only one active (valid_until IS NULL) fact per user+category+key at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_facts_active
    ON user_facts(user_id, category, key)
    WHERE valid_until IS NULL;

ALTER TABLE user_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_facts_permissive ON user_facts
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. session_summaries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_summaries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    summary         text NOT NULL,
    extracted_facts jsonb,
    flagged_concerns text[],
    created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE session_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_summaries_permissive ON session_summaries
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Seed: default user "Margaret"
-- ---------------------------------------------------------------------------
INSERT INTO users (id, name, ios_version, timezone)
VALUES ('00000000-0000-0000-0000-000000000001', 'Margaret', '18.2', 'America/New_York')
ON CONFLICT (id) DO NOTHING;
