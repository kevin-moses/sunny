# Background Runtime (Jobs and Agents)

How Sunny runs work that outlives a request: calendar sync, agent tasks a caregiver asks for, and later relays that wait hours for a family reply. Schema details live in `notes/SCHEMA.md`; this file covers the design and why.

## Where work runs

| Piece | Job | Never does |
| --- | --- | --- |
| Postgres + pg_cron | The clock: task schedule, escalation, day-of event notices, the job queue and its sweep | Call a model or a third-party API |
| Voice agent (LiveKit Cloud now, self-hosted later) | Live conversation with the senior | Outlive the call |
| Edge Functions | Short request/response: `livekit-token`, `google-oauth`, `jobs-run` | Hold state between calls |
| Job queue (`jobs` table + `jobs-run`) | Anything that runs in the background: plain jobs (calendar sync) and agent jobs | Keep a process alive while waiting |
| Agent runtime (Claude Managed Agents for the POC) | Multi-step model work with tools, behind the `AgentRuntime` interface | Hold state that Postgres does not also have |

Research on Meta's Muse and OpenAI's dots (2026-10-26) shaped this: both store schedules and pending work durably and treat compute as disposable. We copy that and skip their always-on VM per user, which costs money while idle and keeps memory caregivers cannot see.

## Job queue

One table, `public.jobs`. A job is a row; running it is a short serverless call.

1. **Enqueue.** SQL enqueues through `private.enqueue_job` (triggers, RPCs such as `request_agent_chat`). A `dedupe_key` merges repeats: at most one queued job per key, so ten quick edits to an event make one Google push.
2. **Dispatch.** Inserting a due job calls the `jobs-run` Edge Function through `pg_net` (async, after commit). The function URL and a shared secret come from Vault (`sunny_functions_url`, `sunny_jobs_secret`); without them, dispatch is skipped and the sweep is the only trigger (tests, unconfigured environments).
3. **Claim.** `jobs-run` answers 202 at once and runs the job in the background (`EdgeRuntime.waitUntil`). `claim_job` takes it with `for update skip locked` and a lease, so duplicate dispatches are harmless.
4. **Finish.** The handler ends with one of: `complete_job` (result), `defer_job` (save a checkpoint, wake at a time: waiting on a person or continuing a long agent run), or `fail_job` (retry with exponential backoff up to `max_attempts`, or fail for good).
5. **Sweep.** pg_cron runs `jobs_sweep` every minute: expired leases count as a failed attempt, waiting jobs whose time has come go back to queued, and every due queued job is dispatched again.

**Pause switch.** `households.background_paused` stops claims for the household's jobs (queued work stays queued). A caregiver "stop" covers every background job at once, unlike dots, where pausing leaves scheduled runs going.

**Resuming never depends on a live process.** Each job stores a checkpoint (`checkpoint_job`; for agents, the Managed Agents session id and the result of every tool call already run). A resume rebuilds from the checkpoint and the database: a tool call whose result is saved is never run again, only re-sent, so a retry cannot add an event twice. Google pushes use event ids derived from Sunny's, so a retried create replaces instead of duplicating.

**Same-key jobs.** At most one job per dedupe key is queued, and jobs sharing a key never run at the same time. A job that would go back to the queue (retry, defer, wake, expired lease) while a newer same-key job is queued is cancelled as superseded: the newer one re-reads current data. One bad job never stops the sweep for other households.

## Agent runtime

`AgentRuntime` (in `supabase/functions/jobs-run/agent.ts`) has one method, `run(job)`, returning done, defer or an error. The POC implementation is `ManagedAgentsRuntime`; a self-hosted Python worker using the Claude API tool runner can implement the same contract later.

**Managed Agents flow (agent_chat job):**

1. The agent and its environment are created once by `supabase/scripts/setup_managed_agent.ts` (ids go into Edge Function secrets `SUNNY_AGENT_ID`, `SUNNY_ENVIRONMENT_ID`). The agent has only custom tools; no shell, files or web.
2. `run` creates a session with the caregiver's message in `initial_events`, prefixed by a household briefing built from Postgres (senior's name, local date and time, timezone). A per-session budget caps spend.
3. It polls the session. For each `agent.custom_tool_use` without a result, it runs the tool through our RPCs as the backend, with the household taken from the job row, never from the model, and posts `user.custom_tool_result`.
4. When the session idles with `end_turn`, the last agent message becomes `jobs.result.reply`. Any other stop (budget reached, refusal, retries exhausted) fails the job with the reason. If the Edge Function's time runs short first, the job defers with the session id and resumes on the next dispatch; a request still unfinished after 30 minutes fails.
5. A follow-up message can continue the same session (`request_agent_chat(..., p_continue_job_id)`, once the earlier request has finished).

**Tools (calendar POC):** `get_calendar(from_date, to_date)`, `add_event(...)`, `update_event(event_id, ...)`, `cancel_event(event_id)`. Each is a thin wrapper over the SQL RPC of the same purpose, so voice, the caregiver app and the agent share one write path and one set of checks. Agent edits apply immediately and are recorded with `created_via = 'agent'` and in `audit_log`.

**Per-household docs.** The briefing is generated from Postgres at session start (later: life profile, verified memory, playbook, agent notes), so caregivers can always see and correct what the agent knows. Nothing durable lives in the sandbox.

**Policy (next step, not in the POC).** Per-household rules per action (allow, ask a caregiver, deny), checked in `jobs-run` before a tool executes. Defaults: message household members freely, ask before contacting anyone else, deny money and credentials. Once a job has read household data, sending outside the household always asks.

**Long waits (next step).** "Ask Sarah and tell Mom" uses a `wait_for_reply` tool that is left unanswered: the job defers as `waiting`, a trigger on the reply (or the timeout via the sweep) re-dispatches it, and the runtime answers the pending tool call. Managed Agents bills session running time, so a paused session costs almost nothing; if the session is gone, the runtime starts a fresh one from the checkpoint.

## Google Calendar sync

Sunny's `events` table is the source of truth. Each caregiver who connects Google gets their own secondary calendar ("Mom (Sunny)") created by Sunny with the narrow `calendar.app.created` scope: Sunny can create and edit calendars it made and nothing else in the account.

- **Connect.** `google-oauth/start` (caregiver JWT) returns a Google consent URL with a signed state. `google-oauth/callback` exchanges the code, stores the refresh token in Vault, creates (or reuses) the calendar in the household's timezone and queues a push for every event.
- **Push (Sunny to Google).** A trigger on `events` queues one `calendar_sync_event` job per active connection. The job builds the Google event from `get_event_sync_payload` (SQL does the timezone math): local start and end with the household timezone, a weekly `RRULE` for repeats, a popup reminder at the household's `event_notice_time` on the day, and our event id in `extendedProperties.private`. Cancelled events are deleted from Google.
- **Day-of notifications.** Two paths: the Google reminder (Google's own app notifies the caregiver) and an `event_notice` row in `notification_outbox` for every caregiver at `event_notice_time` (or right away when the event is added later that day), for the push sender to deliver.
- **Pull (Google to Sunny), next step.** Watch the Sunny calendar (`events.watch`), queue a pull job on each notification, apply changes with incremental sync tokens (410 means full resync), skip our own echoes by etag, renew channels daily from pg_cron. Later edits win; fields only Sunny has (senior label, visibility) are never overwritten.
- **Revocation.** `invalid_grant` marks the connection `revoked` and stops retries; the caregiver reconnects from the app, and reconnecting also pushes cancellations made in the meantime. A caregiver removed from the household loses their connection (and its token) at once.
- **Household changes.** Changing the timezone, notice time or senior's name re-pushes every event.

## LiveKit: Cloud now, self-hosted later

- Noise cancellation is a setting (`NOISE_CANCELLATION=cloud|none`); BVC is a LiveKit Cloud feature.
- Sessions start by explicit agent dispatch by name, created by `livekit-token` (or the backend for scheduled prompts), which works the same on both.
- Deploy with `livekit.toml`; the starter template's CI check that blocks committing it is removed when deploys are set up.

## Not in this milestone

Google pull, the policy engine, `wait_for_reply`, post-call memory extraction, the push sender (APNs), and the caregiver app UI. The caregiver talks to the agent through `request_agent_chat` with `supabase/scripts/caregiver.ts` until the app exists.
