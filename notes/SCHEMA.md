# Shared State Schema (Convex)

How Sunny's Convex tables implement `notes/SPEC.md`. The source of truth is `sunny_backend/convex/schema.ts` (every field is commented there); this file explains what each table is for, who writes it, and the rules the code keeps because the database does not. Enums live in `convex/lib/validators.ts`. History of the move from Supabase: `notes/CONVEX_MIGRATION.md`. Background work: `notes/AGENT_RUNTIME.md`.

## Conventions

- **Instants** are epoch milliseconds (`number`), for example `windowStart`, `expiresAt`, `settledAt`. Convex's own `_creationTime` is also epoch ms, but the scheduler uses explicit `createdAt` where tests must drive the clock.
- **Household-local dates and times** are strings: `"YYYY-MM-DD"` and `"HH:MM"`. Schedules are stored in local terms so 8:00 stays 8:00 across DST; the instant is computed from the household's IANA region timezone (`lib/time.ts`, no dependency). Weekdays are ISO numbers, 1 = Monday.
- **User ids** are Clerk user ids (the identity's `subject`). A senior device is also a Clerk user, created at pairing with `public_metadata.sunny_kind = "device"`.
- **View shapes use `null`.** Results built for the apps (`calendar.dayView`, `listEvents`, `instances.today`, `confirmDueTask`) return `null` for an absent optional value, never a missing key. Raw document returns keep Convex's omitted-field shape.
- **Uniqueness is kept by code.** Convex has no unique constraints. The writing mutation looks the key up through an index first (serializable transactions make check-then-insert safe). Keys: one instance per task, local date and time; one join code per value; one connection per caregiver per household; one verification per member; one digest per household and local date; one sync per event and connection; one `agentToolCalls` row per request and tool use id; one `eventNotices` row per event and date.
- **Actor model.** `actorKind` is `caregiver`, `senior_device`, `agent` or `system`. Every write path records who acted (`createdVia`, `confirmedVia`, audit rows). Public functions resolve the caller through `lib/access.ts` (`requireReader`, `requireEditor`, `requirePrimary`, `requireSenior`) and reject device identities from every caregiver check. Backend-only work is an `internal*` function. The Python voice agent calls `agent:*` functions with `SUNNY_AGENT_KEY` as the first argument; it may pass `now`. Public functions never accept `now` from clients.
- **Deletes.** Events are soft deleted (`deletedAt`) so cancellations sync to Google. Tasks are hard deleted through `tasks.remove` / `purgeTaskData`, which also remove their instances and notifications. There is no household delete yet.
- **Audit.** `lib/audit.ts` writes `auditLog` rows from the mutations that change audited tables. It is called explicitly; nothing is automatic.

## Households and access

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `households` | The senior's profile and household settings: `seniorPreferredName`, `seniorFullName`, `timezone`, `onCallUserId`, `digestTime`, `eventNoticeTime`, `shareTranscripts`, `backgroundPaused` (caregiver "stop"), `lastDigestDate` (skips the digest lookup after the day's digest) | none | `households.create` (seeds the two default policies), `households.update`, `digest.ts` (`lastDigestDate`) |
| `householdMembers` | A caregiver in a household: `role` (`primary`, `member` edits, `viewer` read only), `displayName`, `phone` (E.164), `phoneVerifiedAt`, `pendingPhone` | `by_household_user`, `by_user`, `by_phone` (inbound SMS lookup; callers also check `phoneVerifiedAt`) | `households.*` (create, redeemJoinCode, updateMemberRole, removeMember), `phone.ts` (phone fields) |
| `devices` | A paired senior device: `userId` (its Clerk user), `kind` (`senior_phone`, `home_display`), `name`, `lastSeenAt`, `pairedAt`, `pairingNonce` | `by_user`, `by_household` | `households.pairDevice` (internal, called by `pairing.ts` `/pair`), `removeDevice` |
| `pushTokens` | Raw APNs tokens per user | `by_user`, `by_token` | `households.registerPushToken` / `unregisterPushToken` |
| `joinCodes` | One-time 8-character codes for pairing a device or inviting a caregiver: `grants`, `createdBy`, `expiresAt` (24 h), `redeemedBy`, `redeemedAt` | `by_code`, `by_household` | `households.createJoinCode`, `redeemJoinCode`, `pairDevice`, `deleteJoinCode` |

Rules:
- A household always keeps at least one primary: the last primary cannot be demoted or removed.
- A device's `userId` is a Clerk user made at pairing. Re-pairing creates a new user, so a push token held by an orphaned user (no device row, no membership) may be taken over; a token held by a live account is refused.
- `pairingNonce` and `pairedAt` support retrying a lost `/pair` response for 10 minutes. `listDevices` strips the nonce.
- Removing a member drops their Google connections, links and pending syncs and revokes the grants.
- `backgroundPaused` is read by every workflow step, workpool job, the scheduler and the digest. Resuming re-pushes calendars (`households.update`).

## Tasks and instances

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `escalationPolicies` | A named ladder of ordered `steps` (each: stable `id`, `offsetMinutes`, `action` of `prompt_senior`, `alert_on_call` or `alert_all_caregivers`, `skipIfClaimed`). `systemKey` (`medication`, `prompt_only`) marks the seeded defaults | `by_household`, `by_household_system_key` | `households.create` (seed), `tasks.createPolicy` / `updatePolicy` / `removePolicy` |
| `tasks` | A scheduled item: `type`, `title` (caregiver wording), `displayLabel`, `spokenPrompt`, `pillDescription`, `checklistItems`, `times`, `daysOfWeek`, `onceOn`, `startsOn`/`endsOn`, `windowMinutes`, `escalationPolicyId`, as-needed limits, `createdByKind`, `active`, `scheduleChangedAt` | `by_household`, `by_household_active`, `by_household_policy` | `tasks.create` / `update` / `remove`, `instances.createSeniorReminder` / `cancelSeniorReminder` |
| `taskInstances` | One row per task per scheduled time per local date, with `windowStart`/`windowEnd`, `state`, confirmation fields (`confirmedAt`, `confirmedBy`, `confirmedVia`), `resolutionNote` (why a caregiver resolved it), `snoozedUntil`, `claimedBy` and `claimedAt` ("I'm on it"), `createdAt`, and `firedSteps` (escalation steps already handled, by step id, with a snapshot of the action and whether anyone was notified) | `by_task_date_time` (uniqueness), `by_household_date`, `by_task_state`, `by_household_state` (the tick reads one household's instances by state) | `scheduler.ts` (expand, open, escalate, close), `instances.ts` (confirm, snooze, claim, resolve), `tasks.ts` (resync on schedule change) |
| `doseLog` | As-needed medication taken outside a scheduled instance | `by_household_task_taken` | `instances.logDose` |

State machine (`instanceState`):

```
upcoming --(window_start)--> due --(caregiver alert step fires)--> escalated
   |                          |                                      |
   +--(confirm, <=60 min early)+--(confirm)--> confirmed <--(confirm)-+
                              |                                      |
                              +--(window_end, unconfirmed)--> missed <+
due / escalated / missed --(caregiver marks done)--> resolved
missed --(senior confirms late)--> confirmed (late = confirmedAt > windowEnd)
```

Rules:
- `instances.ts` is the single write path for every surface. A senior device or the agent produces `confirmed`; a caregiver produces `resolved` with `confirmedVia = caregiver`. Confirming an already confirmed or resolved instance returns the original result. `confirmDueTask(household, via, label?)` is what the Done button, widget and voice call; it returns a status (`confirmed`, `already_done`, `nothing_due`, `not_found`, `ambiguous`, `not_due_yet`), so the double-dose guard lives in one place.
- The scheduler tick (`scheduler.ts`, every minute) fans out one `tickHousehold` per household: expand today and tomorrow (idempotent through the `by_task_date_time` lookup; a window that already closed is skipped unless the task existed when it opened), open windows, fire each due escalation step once (recorded in `firedSteps`; when several steps of one kind come due together only the latest is sent and the rest record `notified: false`), mark instances with a fired caregiver alert `escalated`, and close windows to `missed`. Offsets count from the later of `windowStart` and `createdAt`. Snoozes defer senior prompts only; `skipIfClaimed` steps stop once claimed.
- Editing a task's schedule or the household timezone deletes future `upcoming` instances and re-expands; deactivating a task removes its open instances.
- Seeded policies: **Medication** (0 min prompt, 15 min reprompt, 30 min on-call alert, 45 min all caregivers unless claimed) and **Prompt only** (0 min prompt). Seeded policies cannot be deleted or re-keyed. A task with no policy shows on the surfaces and in the digest but never notifies. Senior reminders use the prompt-only policy, found by `systemKey`, so renaming is safe.
- Policy `steps` are embedded. Instances record fired steps by step id, so editing the ladder never makes a step look fired or unfired.

## Calendar and Google sync

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `events` | Appointments and visits in household-local terms: `title`, `label` (gentler wording for the senior), `startsOn`, `startTime`, `durationMinutes`, `place`, `visitorName`, `notes`, weekly repeat (`repeatDays`, `repeatUntil`), `createdVia`, `deletedAt` | `by_household`, `by_household_deleted` | `calendar.ts` (`addEvent`, `updateEvent`, `cancelEvent`), the agent's tools (same functions) |
| `eventNotices` | An occurrence already announced to caregivers (one per event per local date) | `by_event_date` | `lib/eventNotices.ts`, from the household tick |
| `calendarConnections` | A caregiver's Google connection: `userId`, `accountEmail`, `externalCalendarId` (the Sunny-owned calendar), `status` (`active`, `revoked`, `error`), `error`, encrypted `refreshToken`, cached encrypted `accessToken` and `accessTokenExpiresAt`, `lastSyncedAt`, `lastError` | `by_household_status`, `by_household_user` | `googleCalendar.saveConnection`, `calendarPush.ts` (status, `lastError`, token cache), `disconnect` |
| `calendarEventLinks` | Our event to the Google event, per connection: `externalEventId`, `etag`, `syncedAt` | `by_event_connection`, `by_connection` | `calendarPush.recordPush`; removed on disconnect and on a confirmed deletion |
| `calendarSyncs` | The pending push of one event to one connection: `state` (`queued`, `running`, `dirty`), `updatedAt`, `failures` | `by_event_connection` (uniqueness), `by_connection`, `by_updated` (sweeper) | `lib/calendarSync.ts` (queue), `calendarPush.ts` (begin, complete), `calendarFanOut.sweepStuckSyncs` |
| `oauthStates` | Single-use nonce for the Google consent flow: `nonce`, `userId`, `householdId`, `expiresAt` (10 minutes) | `by_nonce`, `by_expires` | `googleCalendar.createOauthState`, consumed by `consumeOauthState`, swept hourly by `sweepOauthStates` |

Rules:
- Occurrences are computed (`lib/occurrences.ts`), not stored. Repeats are weekly only.
- Cancelling is a soft delete (`deletedAt`); clients cannot hard delete events.
- A `calendarSyncs` row exists only while a push is pending, which is what merges repeated edits. Transitions (`queued`, `running`, `dirty`, deleted on completion, the one delayed retry after retries run out, the 15-minute sweeper) are described in `lib/calendarSync.ts`.
- Refresh and access tokens are AES-GCM boxes (`lib/secretBox.ts`) keyed by `CALENDAR_TOKEN_KEY`; they are never returned to clients. Rotating the key means caregivers reconnect.
- One connection per caregiver per household is kept by `saveConnection`, which reactivates the existing row.

## Notifications and delivery

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `notificationOutbox` | The only place notifications are queued. One recipient per row: `recipientDeviceId` (APNs) or `recipientUserId` (SMS). `kind` (`senior_prompt`, `caregiver_alert`, `event_notice`, `digest`), `title`, `body`, `payload`, `state` (`pending`, `sent`, `skipped`, `failed`), `channel` (set only when sent), `settledAt`, `attempts`, `attemptStartedAt` (lease), `detail` (skip reason or internal error, never returned to clients) | `by_recipient_kind` (reply-to-claim), `by_recipient_device`, `by_task_instance` (cascade on instance delete), `by_household`, `by_state` | Inserted only through `insertNotification` in `lib/delivery.ts` (scheduler, event notices, digest); settled by `delivery.ts` |
| `smsInbound` | Inbound texts already handled, by Twilio `MessageSid`, with the stored reply, so a webhook retry claims nothing twice | `by_sid`, `by_expires` | `sms.ts`; swept hourly |

Rules:
- A row leaves `pending` once. Recipient, membership and content are re-checked at send time, so a stale or unreachable row is `skipped` with the reason in `detail`.
- `attempts` is capped (`MAX_ATTEMPTS`) so the sweeper never loops on one row; `attemptStartedAt` is a 5-minute lease the sweeper respects.
- Only tokens APNs reports unregistered are deleted from `pushTokens`.

## Digests

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `digests` | One row per household per local date: `status` (`pending`, `done`, `failed`), `source` (`claude` or `template`), `text`, `error` | `by_household_date` (uniqueness), `by_status` (sweeper) | `digest.queueDigestIfDue` (from the tick), `compose` and `complete` (delivery pool) |

Rules: a paused household gets no digest until resumed; a household created after that day's digest time gets none that day; a digest left `pending` for 15 minutes is re-enqueued by `delivery.sweepStuck`.

## Agent requests

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `agentRequests` | A caregiver's request to the household agent: `requestedBy`, `message`, `continueRequestId`, `status` (`queued`, `running`, `succeeded`, `failed`, `cancelled`), `workflowId`, `sessionId` (Managed Agents), `baselineUserMessages`, `reply`, `error` (caregiver-safe), `errorDetail` (raw, never returned), `finishedAt` | `by_household`, `by_household_status`, `by_session` | `agentRequests.ts` (request, cancel), `agentRuntime.ts` (workflow steps and completion) |
| `agentToolCalls` | One row per tool call for a request: `toolUseId`, `name`, `input`, result `text`, `isError`, `sentAt` | `by_request_tool` (uniqueness), `by_request_sent` | `lib/agentTools.ts`, in the same transaction as the tool's effect |

Rules: at most 5 requests queued or running per household; one in-progress request per session; the message is 1 to 4000 characters; a continuation may only continue a succeeded request of the same household. Status transitions go through `lib/agentRequestState.ts`.

## Voice and agent memory

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `conversations` | One voice session: `trigger` (`talk`, `scheduled_prompt`, `notification_tap`), `deviceId`, `taskInstanceId`, `startedAt`, `endedAt`, `summary` | `by_household_started` | `agent.startConversation` / `finishConversation` |
| `conversationTurns` | What was said: `role`, `content` | `by_conversation` | `agent.logTurn` |
| `agentQuestions` | One row per question the senior asked: `topic`, `outcome`, `toolsUsed`; the digest counts repeats | `by_household_asked` | No writer yet (post-call extraction is not built) |
| `agentMemory` | Facts the agent knows: `fact`, `source`, `verifiedBy`/`verifiedAt`, `conversationId`. Senior-stated facts start unverified and never overwrite verified ones | `by_household` | No writer yet (caregiver app and post-call extraction); read by `agent.getContext` |
| `lifeProfileEntries` | Caregiver-owned people, places, doctors, habits, interests, preferences | `by_household` | No writer yet (caregiver app); read by `agent.getContext` |
| `sensitiveTopics` | Caregiver-written guidance for hard questions | `by_household` | No writer yet; read by `agent.getContext` |
| `familyMessages` | Messages from family to the senior (text, photo or voice clip in `_storage`) | `by_household` | No writer yet; read by `agent.getContext` |

Privacy: conversation summaries, question text and turns carry what the senior said, so caregivers can read them only when `households.shareTranscripts` is true. The digest reports topics and counts. `agent:*` functions require `SUNNY_AGENT_KEY`; the household always comes from the LiveKit participant metadata the token action wrote, never from the model.

## Phone verification

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `phoneVerifications` | The one outstanding verification per member: `phone`, `codeHash` (HMAC bound to user and number, absent until the code exists), `sendError`, `sendErrorDetail`, `expiresAt` (10 minutes), `attempts` (5 wrong guesses lock it) | `by_household_user` (uniqueness), `by_expires` | `phone.ts`: `setMyPhone` replaces the row, `sendCode` stores the hash, `confirmMyPhone` deletes it on success, `sweepExpired` (hourly) |

Rules: the code is made inside the send action and never stored or scheduled in plaintext. `households.myPhoneStatus` (implemented in `phone.ts` and re-exported from `households.ts`) lets a client wait for the send (none, sending, sent, send_failed, expired) and returns only the caller's own pending number. A failed send stores a caregiver-safe `sendError` (generic, or "That number cannot receive texts.") and the raw text in `sendErrorDetail`, which no function returns. `expired` is computed from `Date.now()` inside the query, which Convex does not re-run as time passes, so a subscribed client should compare `expiresAt` with its own clock. Sends are rate limited per caregiver, per caregiver and number, and per day for each caregiver and household. Only verified numbers (`phoneVerifiedAt`) receive texts, and only allowed countries (`SMS_ALLOWED_COUNTRY_CODES`, default US/CA).

## Audit

`auditLog`: `actorUserId`, `actorKind`, `action`, `entity`, `entityId`, `detail`. Index `by_household`. Written only by `lib/audit.ts`.

## Not built yet

Storage rules for photos and voice clips, a household delete, the caregiver-facing read paths for life profile, playbook and memory, and `agentQuestions` extraction.
