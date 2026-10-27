-- 20261027000100_notification_kinds.sql
-- Purpose: Adds the 'event_notice' notification kind (day-of calendar event notices for
-- caregivers). Kept in its own migration because Postgres cannot use a new enum value
-- in the same transaction that adds it; 20261027000300_calendar.sql uses it.

alter type public.notification_kind add value if not exists 'event_notice';
