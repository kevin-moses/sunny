# Background runtime on Convex

How Sunny runs work that outlives a request: the per-minute clock, delivery of notifications, Google Calendar sync, and the agent tasks a caregiver asks for. Tables are described in `notes/SCHEMA.md`; this file covers where work runs, the flows, and the contracts that are not obvious from the code. Module headers in `sunny_backend/convex` are the detailed source. History: `notes/CONVEX_MIGRATION.md`.

Research on Meta's Muse and OpenAI's dots (2026-10-26) shaped the design: both store schedules and pending work durably and treat compute as disposable. We copy that and skip their always-on VM per user, which costs money while idle and keeps memory caregivers cannot see. Here the durable state is Convex tables, and every piece of compute (a mutation, an action, a workflow step) can disappear and be rerun.

## Where work runs

| Piece | Job | Never does |
| --- | --- | --- |
| Convex queries and mutations | Reads and transactional writes: access checks, task and event CRUD, instance confirm, claim, the per-household scheduler pass, queueing deliveries and syncs | Call a model or a third-party API (mutations are deterministic and cannot use WebCrypto or `fetch`) |
| Convex actions | Anything that calls out: Managed Agents, Google, APNs (`"use node"`, `node:http2`), Twilio, Clerk, LiveKit token minting, Claude Haiku for the digest | Hold state; each action reads and writes through internal queries and mutations |
| `crons.ts` | The clock: `scheduler.tick` every minute; every 10 minutes `calendarFanOut.sweepStuckSyncs` and `delivery.sweepStuck`; hourly `googleCalendar.sweepOauthStates`, `phone.sweepExpired`, `sms.sweepInbound` | Do the work inline |
| Scheduler tick and fan-out | `tick` pages through households and schedules one `tickHousehold` each with the same `now`, so no transaction grows with household count. Each household pass runs in its own serializable transaction: expand instances, open and close windows, fire escalation steps, queue event notices and the daily digest | Share a transaction between households |
| Workpool `deliveryPool` | Delivers `notificationOutbox` rows (`delivery.deliver`) and composes digests (`digest.compose`), max 10 in parallel, 5 attempts with exponential backoff | Run a job for a settled row |
| Workpool `calendarSyncPool` | Pushes one event to one caregiver's Google calendar (`calendarPush.push`) with retry and a parallelism cap | Call Google for a paused household or inactive connection |
| Workflow (`agentRuntime.ts`) | One caregiver request to the household agent, as durable steps over a Managed Agents session | Run a step without re-checking the request and the pause switch |
| HTTP routes (`http.ts`) | `POST /pair` (device pairing), `GET /google/callback`, `POST /twilio/sms` (signature checked) | Trust the caller without checks |
| LiveKit voice agent (`sunny_agent`, self-run Python) | The live conversation with the senior. Reads and writes household state through the `agent:*` Convex functions over HTTP, authenticated by `SUNNY_AGENT_KEY` | Outlive the call or write tables directly |
| Claude Managed Agents | The model loop for caregiver requests, behind `lib/managedAgents.ts` | Hold state Convex does not also have |

Components are registered in `convex.config.ts`: rate limiter, workflow, and the two workpools.

**Pause switch.** `households.backgroundPaused` is checked by the scheduler, every workflow step, every push and delivery before it acts, and the digest. A caregiver "stop" covers all background work at once. Resuming re-pushes calendars. Queued work stays queued.

## Agent request flow

A caregiver sends a message with `agentRequests.request` (editors only: primary or member). The mutation validates it (1 to 4000 characters, at most 5 queued or running per household), inserts an `agentRequests` row and starts the workflow. The app subscribes to `agentRequests.get` / `list` for the reply.

1. **Steps.** `markRunning`, `startSession` (creates a Managed Agents session with the message and a household briefing built from Convex: the senior's preferred name, timezone, the local weekday and date/time now, the requesting caregiver's display name, and the coming calendar), then per poll one `pollSession`; when the session needs tool results, `executeToolCalls` and `sendToolResults`; finally `finishRequest`. A reply with no tools is 4 steps; each tool round adds 3.
2. **Tools** (`lib/agentTools.ts`): `get_calendar`, `add_event`, `update_event`, `cancel_event`. Each is a thin wrapper over the same functions the app and voice use (`calendar.ts`), so there is one write path and one set of checks. The household always comes from the request row, never from the model. Agent edits are recorded with `createdVia = agent` and in the audit log. The agent has no shell, files or web (see `lib/agentConfig.ts`; re-run `scripts/setup_managed_agent.ts` after changing it).
3. **Tools run exactly once.** A tool call's `agentToolCalls` row is inserted in the same transaction as its effect. A repeat of the step finds the row and reuses its result; results already sent are marked `sentAt` so a lagging event list is ignored. A retried step therefore cannot add an event twice.
4. **One in-progress request per session.** `request` rejects a continuation while another request in the same session is queued or running. A continuation copies the earlier `sessionId` onto its row up front, and records `baselineUserMessages` (the session's user messages before posting). `finishedTurn` ignores any turn that does not include a newer user message, so a lagging event list cannot return the previous reply.
5. **Pause switch and cancel.** Every acting step re-reads the request and `backgroundPaused` (`readGate`). Paused: the workflow sleeps a minute and retries. A request no longer queued or running (cancelled) ends the run.
6. **30-minute cap.** A request older than `MAX_REQUEST_AGE_MS` (30 minutes from creation, paused time included) fails; the error says it timed out (or timed out while paused).
7. **Per-session budget.** `SUNNY_AGENT_SESSION_BUDGET_CENTS` (default 100) caps spend. A stop for budget, refusal or exhausted retries fails the request.
8. **Caregiver-safe errors.** `error` is plain text shown in the app. Raw detail (SDK errors, env var names, ids) goes to `errorDetail`, which no public query returns, and to the logs. `onRunComplete` fails or cancels the row if the workflow dies while the row is still in progress.
9. **Workflow versioning.** Changing the steps breaks runs in flight. Runs are short (30-minute cap) today. Before `wait_for_reply` ships, workflows need a version field and old versions kept until their runs drain.

Env on the Convex deployment: `ANTHROPIC_API_KEY`, `SUNNY_AGENT_ID`, `SUNNY_ENVIRONMENT_ID`, optional `SUNNY_AGENT_SESSION_BUDGET_CENTS`.

## Google Calendar sync

Sunny's `events` table is the source of truth. Each caregiver who connects Google gets their own secondary calendar (named like "Mom (Sunny)") created by Sunny with the narrow `calendar.app.created` scope: Sunny can create and edit calendars it made and nothing else in the account. Setup: `notes/GOOGLE_CALENDAR_SETUP.md`.

- **Connect.** `googleCalendar.connectUrl` (a public action; caregiver members only, never a device) stores a single-use nonce in `oauthStates` (10-minute TTL) and returns Google's consent URL carrying a signed state. Google redirects the browser to `GET /google/callback`, which verifies the state, consumes the nonce (a second use shows a "link expired" page), exchanges the code, requires the calendar scope, reuses the caregiver's existing Sunny calendar if it still exists (else creates one), encrypts the refresh token (`lib/secretBox.ts`) and calls `saveConnection`. That mutation reactivates the connection and schedules a chunked push of every event that can still occur plus cancelled events still linked. A grant that ends up unused (rejected callback, replaced or dropped connection) is revoked at Google, best effort.
- **State machine** (`calendarSyncs`, described once in `lib/calendarSync.ts`). One row exists per event and connection while a push is pending: `queued`, then `running` when the push begins, `dirty` if the event changes while it runs, deleted on completion (a dirty row goes back to `queued`). This is what merges ten quick edits into one Google write. Retries exhausted: the row is tried once more after a delay, and the connection gets a caregiver-safe `lastError` that the next success clears.
- **Push.** `calendarPush.push` builds the Google event (local start and end in the household timezone, a weekly `RRULE` for repeats, a popup reminder at `eventNoticeTime` on the day, our event id in `extendedProperties.private`). Google event ids derive from Sunny's, so a retried create replaces instead of duplicating. The access token is cached encrypted on the connection and refreshed only when missing, near expiry, or after a 401. Cancelled events are deleted from Google.
- **Chunked fan-out.** Backfill after connecting and resync after a household change (timezone, notice time, senior's name, pause ending) never run inline: `calendarFanOut.chunk` queues at most `FAN_OUT_CHUNK` syncs and schedules the next until the events are done.
- **Sweeper.** Every 10 minutes `sweepStuckSyncs` re-enqueues rows idle for 15 minutes (a lost job).
- **Revoke and removal.** Revoked access (`invalid_grant`) marks the connection `revoked` and stops retries; the caregiver reconnects, which also pushes cancellations made meanwhile. A calendar Google confirms gone, a permanent 403, or credentials Sunny can no longer decrypt mark it `error`. One event's 404 does not disable the connection. Dropping a connection (`disconnect`, or a caregiver leaving the household) deletes its links and pending syncs and schedules revocation of the grant; a running push finds its row gone and stops. `disconnect` leaves the Google calendar as it is.
- **Day-of notices.** Two paths: the Google popup (Google's own app notifies the caregiver) and an `event_notice` outbox row for every caregiver at `eventNoticeTime` (or right away for an event added later that day, if it has not started), written by the household tick.

## Delivery

Every notification is a `notificationOutbox` row inserted through `insertNotification` (`lib/delivery.ts`), which enqueues `delivery.deliver` on `deliveryPool`.

- **Routing.** A device recipient gets APNs to every push token of its user. A member recipient gets an SMS at the verified phone (title and body on separate lines; a `caregiver_alert` for a member who can claim ends with a reply hint). Membership, device and content are re-checked at send time; an unreachable or stale row is `skipped` with the reason in `detail`.
- **APNs.** `apns.ts` uses `node:http2` (one session per send call, 10-second timeout per request); payload and provider token live in `lib/apnsPayload.ts`. A row counts as sent when any token was accepted; only tokens APNs reports unregistered are deleted. Env: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` (set with `npx convex env set APNS_KEY_P8 --from-file <key.p8>`), `APNS_ENVIRONMENT` (development for dev builds), optional `APNS_BUNDLE_ID`.
- **SMS.** Twilio REST through `lib/twilio.ts`. A retryable failure is thrown so the pool retries with backoff. An SMS that timed out is retried only for a `caregiver_alert`; for other kinds the text may already have arrived, so the row is failed rather than risk a duplicate. A configuration problem leaves the row pending with the detail recorded, so the sweeper retries after the fix (bounded by `MAX_ATTEMPTS`). Inbound `POST /twilio/sms` handles "1" / "on it" to claim the newest texted alert (`sms.ts`; MessageSid dedupe; viewers cannot claim). Phone verification: `phone.ts` (HMAC-hashed codes, rate limits, allowed countries). Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`, optional `SMS_ALLOWED_COUNTRY_CODES`.
- **Daily digest.** `queueDigestIfDue` (from the household tick) records a `digests` row once local time reaches `digestTime`, then `digest.compose` writes the not-done and alert lines from a template and asks Claude Haiku for the rest (`lib/digestText.ts`), falling back to the whole template on any failure; `complete` stores the text and inserts one `digest` outbox row per member with a verified phone.
- **Sweepers.** `delivery.sweepStuck` (every 10 minutes) re-enqueues deliveries and digests left pending for 15 minutes. A row a run started less than 5 minutes ago is leased and left alone. Retries exhausted ends the row as `failed`; a settled row is never delivered again.

## Voice agent

`sunny_agent` is a LiveKit Agents worker (Deepgram STT, Claude Haiku, Cartesia TTS, Tavily search). A senior device gets a room token from `voice.livekitToken`; its participant metadata (`household_id`, `device_id`, `trigger`, `task_instance_id`) is the only place the agent learns the household. The agent calls `agent:getContext`, `today`, `confirmDueTask`, `createSeniorReminder`, `cancelSeniorReminder`, `startConversation`, `logTurn` and `finishConversation` through Convex's `/api/query` and `/api/mutation`.

## Not built yet

- **Google pull** (Google to Sunny): watch the Sunny calendar, apply incremental changes, skip our own echoes by etag, renew channels daily. Later edits win; fields only Sunny has are never overwritten.
- **`wait_for_reply`**: "ask Sarah and tell Mom" leaves a tool call unanswered and the workflow `awaitEvent`s; the Twilio webhook or an in-app reply calls `sendEvent`. Needs workflow versioning first.
- **Live Activity** pushes, deferred until the app adopts ActivityKit.
- **Caregiver app**: caregivers use `sunny_backend/scripts/caregiver.ts` and SMS until it exists. Resend (email) is unused for the same reason.
- **Policy engine**: per-household allow, ask or deny rules checked before a tool executes. Planned defaults: message household members freely, ask before contacting anyone else, deny money and credentials.
- **Post-call memory extraction** into `agentMemory` and `agentQuestions`.
- **Live SMS verification**: Twilio A2P 10DLC / toll-free registration is pending; SMS has not been tested end to end.
