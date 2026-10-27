# Shared State Schema (POC)

Design notes for the Supabase schema behind every surface. Source of truth for behavior is `notes/SPEC.md`; this file records how the schema implements it. Migrations live in `supabase/migrations/`, tests in `supabase/tests/`.

## Identity

- **Caregivers** sign in with Supabase Auth (Sign in with Apple or email). A caregiver belongs to one or more households through `household_members` with a role: `primary`, `member` (can edit) or `viewer` (read only).
- **Senior devices** (the phone app and the home display) sign in anonymously with Supabase Auth, then redeem a one-time **join code** a caregiver generated. Redeeming creates a `devices` row that ties that anonymous user to the household. The senior never types anything beyond the code at setup, and a caregiver can do it for them.
- **Join codes** cover both device pairing and caregiver invites (`join_codes.grants`), redeemed by one RPC. Codes are 8 characters from a cryptographic random source and expire after 24 hours.
- **Backend** means the service role (agent, Edge Functions) or a direct database session with no JWT (pg_cron, migrations, tests); a request through the API without a role claim is never the backend. Only backend callers may pass their own clock (`p_now`).
- **The agent** uses the service role key and passes the household explicitly.
- Every RLS policy resolves `auth.uid()` to a household through `household_members` or `devices` (`private.my_household_ids()`).

## Entities

| SPEC entity | Table(s) |
| --- | --- |
| Household | `households` (senior profile, timezone, on-call caregiver, digest time, sharing preferences), `household_members`, `devices`, `join_codes` |
| Life profile | `life_profile_entries` (people, places, doctors, habits, interests, preferences), `sensitive_topics` (playbook) |
| Agent memory | `agent_memory` (source caregiver/senior, verified flag, optional `conflicts_with`) |
| Task | `tasks` (schedule rule: `times`, `days_of_week`, `once_on`, `starts_on`/`ends_on`; window; wording; pill description; as-needed limits; checklist items; escalation policy) |
| Task instance | `task_instances` (one row per task per scheduled time per local date) |
| Escalation policy | `escalation_policies`, `escalation_steps`; fired steps recorded in `instance_escalations` |
| Event (calendar) | `events` (local-time schedule with optional weekly repeat, soft delete), `event_notices` (day-of notices already sent) |
| Google Calendar sync | `calendar_connections` (one per caregiver, refresh token in Vault), `calendar_event_links` (our event to the Google event, per connection) |
| Background work | `jobs` (queue for calendar sync and agent jobs; see `notes/AGENT_RUNTIME.md`) |
| Message | `family_messages` (the old `messages` name is avoided) |
| Conversation log | `conversations`, `conversation_turns`, `agent_questions` (topic, outcome, tools; repeat counts are computed) |
| Audit log | `audit_log` (written by triggers) |
| Self-reported doses | `dose_log` (as-needed medication taken outside a scheduled instance) |
| Push delivery | `push_tokens`, `notification_outbox` |

## Task instance state machine

```
upcoming --(window_start)--> due --(caregiver alert step fires)--> escalated
   |                          |                                      |
   +--(confirm, <=60 min early)+--(confirm)--> confirmed <--(confirm)-+
                              |                                      |
                              +--(window_end, unconfirmed)--> missed <+
due / escalated / missed --(caregiver marks done)--> resolved
missed --(senior confirms late)--> confirmed (late = confirmed_at > window_end)
```

- `confirm_task_instance` is the single write path for every surface. A senior device or the agent produces `confirmed`; a caregiver produces `resolved` with `confirmed_via = caregiver`. Confirming an already confirmed or resolved instance is a no-op that returns the row.
- `confirm_due_task(household, via, label?)` is what the Done button, the widget and voice call. With no label it confirms the earliest due task ("top one if two"); with a label it matches today's display labels. It returns a status (`confirmed`, `already_done` with the original time, `nothing_due`, `not_found`, `ambiguous`, `not_due_yet`), so the double-dose guard lives in one place.
- `get_today(household)` returns today's instances for any surface.
- `create_senior_reminder` and `cancel_senior_reminder` handle "remind me to..." for the senior's devices and the agent. Reminders use the household's prompt-only policy (found by `escalation_policies.system_key`, so renaming a policy is safe) and only senior-created reminders can be cancelled this way.
- Every task has a `spoken_prompt`; when a caregiver leaves it blank it defaults to "Time for <label>.", so push, display and voice use the same words.
- `p_now` on these RPCs is honored only for backend callers (agent, pg_cron, tests); end users always get the server clock.
- `snooze_task_instance` defers senior prompts only; caregiver alerts keep their schedule.
- `claim_task_instance` records "I'm on it"; steps marked `skip_if_claimed` stop firing.

## Scheduler

All scheduling is SQL, run by `pg_cron` once a minute (`scheduler_tick`). Every function takes `p_now` so tests are deterministic.

1. **Expand**: create instances for today and tomorrow in each household's local timezone. Idempotent through `unique (task_id, local_date, scheduled_time)`. Window start is `(local_date + time) at time zone household.timezone`, so a daily 8:00 stays 8:00 local across DST; only region timezones (`America/New_York`) are accepted. An instance whose window already closed is skipped unless the task existed when the window opened. Editing a task's schedule, or the household's timezone, deletes future `upcoming` instances and re-expands immediately; deactivating a task removes its open instances.
2. **Open windows**: `upcoming` to `due` at `window_start`.
3. **Fire escalation steps**: for each open instance of an active task and each step whose offset has passed, insert into `instance_escalations` (primary key prevents double firing) and write one `notification_outbox` row per recipient. Offsets count from the later of the window start and when the instance was created, so a task added mid-window starts its ladder then rather than paging caregivers at once. When several steps of the same kind come due in one tick (after a snooze or downtime), only the latest prompt and the latest alert are sent; the rest are recorded with `notified = false`. Caregiver alert steps move the instance to `escalated`.
4. **Close windows**: `due`/`escalated` to `missed` at `window_end`.

Default policies are seeded per household: **Medication** (0 min prompt, 15 min reprompt, 30 min on-call alert, 45 min all caregivers unless claimed) and **Prompt only** (0 min prompt). A task with no policy shows on the surfaces and in the digest but never notifies.

## Calendar

Events are the appointments and visits the display's Next up and the day clock show. The schedule is in household-local terms, like tasks: `starts_on` + `start_time` (+ optional `duration_minutes`), and an optional weekly repeat (`repeat_days`, ISO weekdays, until `repeat_until`). Occurrences are computed (`private.event_occurrences`), so 2 PM stays 2 PM local across DST. Repeats are weekly only; anything richer from Google will arrive as single events when pull sync is built.

- **One write path.** `add_event`, `update_event`, `cancel_event` and `list_events` serve the agent, the caregiver app and voice. Callers are the backend or a caregiver who can edit; `created_via` records who (caregiver, agent, senior device). Cancelling is a soft delete (`deleted_at`) so the deletion can sync to Google; clients cannot hard-delete events.
- **Day view.** `get_day_view(household)` is the day clock for every surface: weekday, date, part of day ("Thursday afternoon"; morning 5-12, afternoon 12-17, evening 17-21, night otherwise), today's tasks, today's events, Next up, and the coming week.
- **Day-of notices.** `event_notice_tick` (pg_cron, every minute) queues an `event_notice` for every caregiver once per occurrence, at the household's `event_notice_time` (default 8:00), or right away for an event added later that day, as long as it has not started. The synced Google event carries a popup reminder at the same time.
- **Google sync.** Each connected caregiver gets a Sunny-owned calendar in their Google account; edits to `events` queue `calendar_sync_event` jobs that push them. Details in `notes/AGENT_RUNTIME.md`.

## Background jobs

`jobs` is the queue for everything that runs outside a request (see `notes/AGENT_RUNTIME.md`). Kinds today: `calendar_sync_event` (push one event to one connection) and `agent_chat` (a caregiver's request to the agent). Caregivers can read their household's jobs, which is how a client reads the agent's reply; only the backend writes them. `households.background_paused` stops claims for a household.

## Privacy

Conversation summaries, question text and turns all carry what the senior said, so caregivers can read them only when `households.share_transcripts` is true (agreed at onboarding). The digest reads them with the service role and reports topics and counts. Agent memory keeps its source fixed, and verifying a fact always records the caregiver who did it.

## Delivery

`notification_outbox` is the only place notifications are queued: `senior_prompt` and `caregiver_alert` from the escalation ladder, and `event_notice` for day-of calendar events. Surfaces read their own rows through Realtime (the display chimes on a new `senior_prompt`); a push sender Edge Function (not built yet) delivers APNs pushes and marks rows sent. Realtime is enabled on `task_instances`, `notification_outbox`, `events` and `family_messages`.

## Not in this step

Daily digest generation, the push sender, Google pull sync, storage buckets for photos and voice clips.
