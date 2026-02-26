-- =============================================================================
-- 006_api_p2_tables.sql
--
-- Tables required by EPIC-API-P2 (caregiver endpoints), ADHERENCE-1, and CG-2.
-- Creates:
--   - adherence_log     : tracks medication confirmation status per reminder fire
--   - caregiver_links   : associates a caregiver with a senior + notification prefs
--   - caregiver_devices : stores FCM push tokens for caregiver devices
--
-- RLS enabled on all tables with permissive policies.
-- TODO (Phase 3): Tighten RLS with real auth (JWT-based user_id checks).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. adherence_log
-- Tracks each medication reminder fire and whether the senior confirmed it.
-- Created when send-reminders fires a medication push. Updated by agent via
-- log-adherence (API-3) or caregiver-dashboard (API-2) reads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS adherence_log (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    reminder_id    uuid        NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scheduled_time timestamptz NOT NULL,
    status         text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'confirmed', 'skipped', 'missed', 'escalated')),
    confirmed_at   timestamptz,
    followup_count integer     NOT NULL DEFAULT 0,
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adherence_log_user_status
    ON adherence_log(user_id, status, created_at DESC);

ALTER TABLE adherence_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY adherence_log_permissive ON adherence_log
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. caregiver_links
-- Associates a caregiver account with a senior they monitor.
-- Also stores per-link notification preferences.
-- Unique on (caregiver_user_id, senior_user_id) so one link per pair.
-- NOTE: caregiver_user_id intentionally has no FK to users(id) — MVP auth uses a
-- hardcoded TEST_USER_ID sentinel that may not exist in the users table. Phase 3 will
-- add the FK once real JWT auth is in place.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS caregiver_links (
    id                   uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    caregiver_user_id    uuid    NOT NULL,
    senior_user_id       uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    relationship         text,
    notify_escalations   boolean NOT NULL DEFAULT true,
    notify_daily_summary boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (caregiver_user_id, senior_user_id)
);

ALTER TABLE caregiver_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY caregiver_links_permissive ON caregiver_links
    FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. caregiver_devices
-- Stores the FCM push token for each caregiver device.
-- Unique on (caregiver_user_id, platform) so one token per platform per user.
-- updated_at is refreshed on token refresh via caregiver-register upsert.
-- NOTE: caregiver_user_id intentionally has no FK to users(id) for the same reason
-- as caregiver_links above (MVP TEST_USER_ID sentinel). Phase 3 will add the FK.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS caregiver_devices (
    id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
    caregiver_user_id uuid    NOT NULL,
    fcm_token         text    NOT NULL,
    platform          text    NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios', 'web')),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (caregiver_user_id, platform)
);

ALTER TABLE caregiver_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY caregiver_devices_permissive ON caregiver_devices
    FOR ALL USING (true) WITH CHECK (true);
