# Convex Migration Plan

Written 2026-10-28. Moves Sunny's backend from Supabase (Postgres, RLS, pg_cron, Edge Functions) to Convex. The React Native (Expo) app landed on main on 2026-10-29 and is merged into this branch; it now runs on Clerk and Convex. This work happens on `worktree-convex-migration`.

Behavior does not change. `notes/SPEC.md` is still the product, and `notes/SCHEMA.md` and `notes/AGENT_RUNTIME.md` describe the behavior each Convex module must keep. Both were rewritten for Convex in phase 6; the Supabase-era file names mentioned in this plan no longer exist in the repo.

## Why

Picked over staying on Supabase for: reactive queries (every surface is a live view of one state, no polling or re-fetch on row diffs), schema in TypeScript, faster agent iteration, durable workflows for long agent runs (`awaitEvent` for "ask Sarah and tell Mom"), and the Resend and Twilio components. Step-by-step navigation and high-frequency location writes are deferred until that feature is built.

## Target architecture

| Piece | Supabase today | Convex |
| --- | --- | --- |
| Backend code | `supabase/migrations/*.sql`, `supabase/functions/*` | `sunny_backend/convex/*` (one npm package, its own `package.json`) |
| Auth | Supabase Auth: caregivers by email/Apple, devices anonymous | Clerk for everyone, through `convex/react-clerk` in the app. Devices get a Clerk user created at pairing (below) |
| Access rules | RLS policies and `private.*` helpers | Explicit checks in every public function through `lib/access.ts`; anything backend-only is an `internal*` function |
| Scheduler | `scheduler_tick`, `event_notice_tick` under pg_cron | `crons.ts` calling internal mutations every minute |
| Realtime | `supabase_realtime` publication (unused; app polled every 30 s) | Reactive queries: the app subscribes to `dayView`, `outbox`, etc. |
| Job queue | `jobs` table, pg_net dispatch, sweep, leases | `@convex-dev/workflow` for agent runs, `@convex-dev/workpool` for calendar pushes; a small `jobs` table remains for what caregivers read (agent replies) |
| Agent runtime | `jobs-run` Edge Function polling Managed Agents | The same `AgentRuntime` contract inside a Workflow: each poll and tool call is a step |
| Google tokens | Vault | AES-GCM encrypted in `calendarConnections`, key in a Convex env var |
| Edge Functions | `livekit-token`, `google-oauth`, `jobs-run` | Convex actions and HTTP actions (`http.ts`) |
| Push delivery | `notification_outbox` (sender not built) | Same outbox table; sender is an action calling APNs directly (the app registers raw APNs device tokens, no Expo push service) |
| Email, SMS | Not built | `@convex-dev/resend` (digest, alerts), `@convex-dev/twilio` (alerts, replies) |
| Python voice agent | supabase-py with the service role key | Convex HTTP API (`/api/query`, `/api/mutation`) on `agent:*` functions that require `SUNNY_AGENT_KEY` |
| Tests | pgTAP (`supabase/tests/*.sql`, ~150 assertions) | `convex-test` + Vitest in `sunny_backend/convex/*.test.ts` |
| Hosting | Supabase Cloud | Convex Cloud (dev and prod deployments) |

## Identity and access

**Caregivers** sign in with Clerk (Sign in with Apple, email). Convex is configured with Clerk's issuer and `applicationID: "convex"`. `ctx.auth.getUserIdentity().subject` (the Clerk user id) is the user key stored in `householdMembers.userId`, `devices.userId`, `pushTokens.userId` and so on.

**Senior devices** keep the join-code flow. Clerk has no anonymous users, so pairing creates one:

1. The device (signed out) POSTs the code to the HTTP action `/pair`, which is rate limited per client because it is unauthenticated.
2. The action redeems the code in a mutation (single use, 24 h expiry, unchanged rules), creates a Clerk user for the device through Clerk's Backend API (`public_metadata.sunny_kind = "device"`), records the `devices` row with that user id, and creates a Clerk sign-in token.
3. The app signs in with Clerk's `ticket` strategy. From then on the device is an ordinary Clerk session, so `convex/react-clerk` works the same on every surface.
4. Unpairing deletes the device row, its push tokens and the Clerk user.

Re-pairing always creates a new Clerk user, and a device that was unpaired remotely cannot clean up after itself. So a push token held by an orphaned user (no device row, no membership) may be taken over; a token held by a live account is refused.

Caregiver invites stay join codes too, redeemed by a signed-in caregiver through the `households.redeemJoinCode` mutation.

**Device claim.** The Clerk JWT template `convex` maps `public_metadata.sunny_kind` into a `sunny_kind` claim. Every caregiver check rejects identities with `sunny_kind = "device"`, so a device's login can never act as a caregiver, even after it is unpaired or if pairing failed halfway. This replaces Supabase's `is_anonymous` claim.

**Last primary.** A household always keeps at least one primary caregiver: the last one cannot be demoted or removed. (The SQL did not guard this.)

**Access rules** replace RLS. `lib/access.ts` resolves the caller once (`caregiver` with roles per household, `senior_device` bound to one household, or none) and exposes `requireReader`, `requireEditor`, `requirePrimary`, `requireSenior`. Every public query and mutation calls one of them first; the test suite has an access test per public function, the same way pgTAP checked grants.

**Backend callers** are internal functions (crons, workflows, other functions) and the voice agent. The agent calls public `agent:*` functions whose first argument is `agentKey`, checked in constant time against `SUNNY_AGENT_KEY`. The household always comes from the LiveKit participant metadata the token action wrote, never from the model.

**Clock.** Only backend callers may pass `now` (internal functions and `agent:*`), exactly as `p_now` worked. Public functions use `Date.now()`.

## Data model conventions

- Instants are epoch milliseconds (`number`). Household-local dates are `"YYYY-MM-DD"` strings, local times `"HH:MM"`. Weekdays are ISO numbers, 1 = Monday.
- Timezone math lives in `lib/time.ts` (IANA zones through `Intl`, no dependency) and is tested across both New York DST changes, the same cases the SQL tests covered.
- Uniqueness the database used to enforce (one instance per task, local date and time; one join code per value; one connection per caregiver) becomes an index lookup inside the writing mutation. Convex mutations are serializable, so check-then-insert is safe.
- Foreign keys and cascades become explicit: deleting a household runs an internal mutation that removes its rows table by table.
- Every table that was audited by triggers is audited by `lib/audit.ts`, called from the mutations that change it.
- Soft deletes stay where they had a reason (events, so cancellations sync to Google).
- View-shaped results returned to the apps (`dayView`, `listEvents`, `instances.today`, `confirmDueTask`) use `null`, never a missing key, for absent optional values; raw document returns (`Doc<...>`) keep Convex's omitted-field shape.

## Reactivity and the clock

Convex queries re-run when data they read changes, not when time passes. Two rules follow:

1. State changes driven by time (upcoming to due, escalation, missed) stay in the per-minute scheduler mutation, so surfaces update when it writes.
2. Views that depend on the current time (`dayView`'s "Thursday afternoon" header and Next up) take a `minute` argument the client bumps every minute. The server still uses its own `Date.now()`; the argument only makes the subscription re-run.

## Long-running work

- **Agent requests.** `agent_chat` becomes a Workflow: start or continue the Managed Agents session (step), then loop: poll the session (action step), run each pending tool call (mutation step, recorded once, so a retry never adds an event twice), send results (action step), `step.sleep` between polls. The reply is written to the caregiver-visible `agentRequests` row, which the app subscribes to.
- **Waiting on people** (`wait_for_reply`, next milestone): the workflow `awaitEvent`s; the Twilio inbound webhook or an in-app reply calls `sendEvent`.
- **Calendar pushes.** A `calendarSyncs` table holds at most one pending push per event and connection (the old dedupe key); a Workpool runs them with retries and backoff, one at a time per key.
- **Pause switch.** `households.backgroundPaused` is checked by every workflow step and workpool job before it acts, so a caregiver "stop" still covers everything.
- **Workflow versioning.** Changing a workflow's steps breaks runs in flight. Agent runs are short today (30-minute cap). Before `wait_for_reply` ships, workflows get a version field and old versions are kept until their runs drain.

## Phases

Each phase ends with its tests passing, `npx convex dev --once` deploying cleanly, pre-commit green, `/simplify` and the TLM reviewer run. Sonnet subagents write the code; the lead session writes briefs, reviews and merges. Parallel subagents each get their own git worktree, branched from this one.

1. **Foundation** (done 2026-10-28, commits `cff4731`..`27b44f7`, 294 tests), in three waves:
   - **Wave 1:** package scaffold, the shared-state schema (jobs and calendar-sync tables arrive with their phases), `lib/time.ts`, `lib/access.ts`, `lib/audit.ts`, `lib/today.ts`, default policies, households, members, join codes, internal `pairDevice`, push tokens. Time and household tests.
   - **Wave 2, in parallel:** (a) tasks, escalation policies (seeded ones cannot be deleted or re-keyed), instance RPCs (confirm, confirmDueTask, snooze, claim, senior reminders, dose log), expansion, the scheduler tick and `crons.ts`, the household timezone resync (only when the zone actually changes), ported from `scheduler.test.sql`; (b) events CRUD, occurrences, `listEvents`, `dayView`, ported from the calendar half of `calendar_jobs.test.sql`.
   - **Wave 3:** merge, `/simplify`, TLM review, pre-commit, commit.
2. **Devices and voice** (done 2026-10-29, commit `50c34d3`; verified against the dev deployment `enduring-ostrich-959` with the real Clerk and LiveKit instances): `/pair` with Clerk device users and rate limiting, `voice.livekitToken` action (same participant metadata as the Edge Function), `agent:*` functions (`getContext`, `today`, `confirmDueTask`, `createSeniorReminder`, `cancelSeniorReminder`, `startConversation`, `logTurn`, `finishConversation`), and the Python agent moved from supabase-py to the Convex HTTP API.
3. **Agent runtime** (done 2026-10-29; verified live on the dev deployment: a caregiver request added an event through Managed Agents and a continued request moved it). `agentRequests` (request, get, list, cancel; one in-progress request per session), the Workflow port of `ManagedAgentsRuntime` in `agentRuntime.ts` (4 steps for a reply without tools, 3 more per tool round; tool calls recorded in `agentToolCalls` in the same transaction as their effect), the tools and briefing in `lib/agentTools.ts` and `lib/agentBriefing.ts`, and `scripts/setup_managed_agent.ts` and `scripts/caregiver.ts` (dev deployment only). Caregivers see a plain `error`; raw detail stays in `errorDetail` and the logs. Convex env: `ANTHROPIC_API_KEY`, `SUNNY_AGENT_ID`, `SUNNY_ENVIRONMENT_ID`, optional `SUNNY_AGENT_SESSION_BUDGET_CENTS`.
4. **Calendar sync** (done 2026-10-29; verified live on the dev deployment: a caregiver connected Google, the existing event was pushed, and an edit re-synced). Day-of notices run in the per-household tick (`lib/eventNotices.ts`). Google: `lib/google.ts`, `lib/googleEvent.ts`, `lib/secretBox.ts` (AES-GCM; rotating `CALENDAR_TOKEN_KEY` means caregivers reconnect), single-use OAuth state nonces (`oauthStates`), `GET /google/callback`, `calendarSyncs` (one queued/running/dirty row per event and connection, swept when stuck) pushed through the `calendarSyncPool` Workpool, chunked background backfill and resync (`calendarFanOut.ts`), grants revoked when a connection is dropped. Setup and env vars: `notes/GOOGLE_CALENDAR_SETUP.md`. Google pull (Google to Sunny) is still a later step.
5. **Delivery** (built 2026-10-29). Every outbox row goes through `insertNotification` and the `deliveryPool` Workpool (`delivery.ts`, `lib/delivery.ts`; state pending/sent/skipped/failed, recipient and staleness re-checked at send time, sweeper cron).
   - **Senior devices:** APNs over `node:http2` (`apns.ts`, `lib/apnsPayload.ts`). Verified live: a prompt reached a paired iPhone through the sandbox.
   - **Caregivers:** SMS through Twilio REST (`lib/twilio.ts`, `sms.ts`). This covers phone verification (`phone.ts`, HMAC-hashed codes, US/CA only, rate limits) and "reply 1 to claim" on `POST /twilio/sms` (signature-checked, MessageSid dedupe).
   - **Daily digest:** written by Claude Haiku with a deterministic template fallback, sent by SMS (`digest.ts`, `lib/digestFacts.ts`, `lib/digestText.ts`).
   - **Still to do:**
     - SMS is not live-tested. The Twilio account is upgraded and KYC-approved, but A2P 10DLC / toll-free registration is pending, and `TWILIO_FROM_NUMBER` must be the Twilio number.
     - Live Activity pushes are deferred until the app adopts ActivityKit.
     - Resend is unused, because caregivers get SMS until the caregiver app exists.
   - **Env:**
     - APNs: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` (set it with `npx convex env set APNS_KEY_P8 --from-file <key.p8>`), `APNS_ENVIRONMENT` (development for dev builds), optional `APNS_BUNDLE_ID`.
     - Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`.
     - Optional: `SMS_ALLOWED_COUNTRY_CODES`.
6. **Cutover** (in progress, 2026-10-29).
   - **Done:** the app runs on Clerk and Convex and no longer depends on Supabase. `supabase/` is removed (migrations, Edge Functions, seed, pgTAP tests, scripts) along with its .gitignore entries; comments that cited its files now describe the history in words. `notes/SCHEMA.md` and `notes/AGENT_RUNTIME.md` are rewritten for Convex and `notes/HANDOFF.md` is now the code map of the current repo. `scripts/caregiver.ts phone` waits for the verification text to go out (new `phone.myPhoneStatus` query) and reports a send failure.
   - **Open:**
     - Convex Cloud production deployment (separate Clerk production instance, Google and Apple OAuth credentials, redirect URIs, env vars). Runbook: `notes/PRODUCTION.md`.
     - BAAs confirmed with Convex, Clerk, Twilio (and the other vendors that touch household data) before real pilot data.

## What the React Native app needs from this

This is now implemented in `sunny_app` (see its README); the contract is kept here for reference.

- `sunny_backend/convex/_generated/api` for typed calls: the app imports its type only (`import type`) and calls through `anyApi`, so Metro never bundles backend files. Regenerate `_generated` after backend changes.
- Env: `EXPO_PUBLIC_CONVEX_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` are optional overrides; `sunny_app/src/config.ts` defaults to the dev deployment and the dev Clerk instance (`sharing-robin-1599`).
- Surfaces subscribe to `calendar.dayView({ householdId, minute })` and `notifications.myOutbox({})` instead of polling; Done calls `tasks.confirmDueTask`.
- Call `households.unregisterPushToken` on sign-out. A token registered to another live account is refused; one left behind by an unpaired device is taken over.
- Pairing: POST `{ code, name?, pairingNonce? }` to `<CONVEX_SITE_URL>/pair`, then sign in to Clerk with the returned `ticket`. The app should generate a random `pairingNonce` (16 to 128 characters) once per pairing attempt and resend the same value on every retry of that attempt. If the first response is lost, a retry with the same code and nonce within 10 minutes returns a fresh ticket for the same device user instead of 404; without a nonce, or after 10 minutes, a used code stays 404. A 429 means too many failed attempts; wait for `Retry-After`. Voice: call the `voice.livekitToken` action (same `{ serverUrl, participantToken }` response the app reads today).
- The Clerk JWT template must be named `convex` and include `"sunny_kind": "{{user.public_metadata.sunny_kind}}"`.

## Assumptions to confirm

- Nothing in the current Supabase project needs migrating (no pilot data). If that's wrong, phase 6 gains an export and import step, and Google connections must be redone (tokens are in Vault).
- Convex Cloud, not self-hosted.
- Claude Managed Agents stays the agent runtime (ported, not replaced by `@convex-dev/agent`).
- Clerk application `app_3LNerhAMfPjrTkqutGAhqN7eOhU` (dev instance `https://sharing-robin-1599.clerk.accounts.dev`, set as `CLERK_JWT_ISSUER_DOMAIN`) has the `convex` JWT template. Email is optional at sign-up and passwords are off, so `/pair` creates device users with only a random `device_<32 hex>` username (Clerk refuses sign-in tickets for users with no identifier; optional usernames are enabled on the instance); caregivers sign in with Google, Apple or an email code. Production needs its own Google and Apple OAuth credentials.
- Convex env vars needed on real deployments: `CLERK_JWT_ISSUER_DOMAIN`, `CLERK_SECRET_KEY` (device users and sign-in tokens), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SERVER_URL`, `SUNNY_AGENT_KEY` (shared with the voice agent, which also needs `CONVEX_URL`).
