# Shared State Schema (Convex)

This file describes how Sunny's Convex tables implement `notes/SPEC.md`. The source of truth for field names and validators is `sunny_backend/convex/schema.ts`, and the code has no comments. This file explains what each table is for, who writes it, and which rules the code keeps because the database does not keep them. Enums live in `convex/lib/validators.ts`. The history of the move from Supabase is in `notes/CONVEX_MIGRATION.md`, and background work is in `notes/AGENT_RUNTIME.md`.

## Conventions

- **Instants** are epoch milliseconds (`number`), for example `windowStart`, `expiresAt` and `settledAt`. Convex's own `_creationTime` is also epoch ms, but the scheduler uses an explicit `createdAt` where tests must drive the clock.
- **Household-local dates and times** are strings: `"YYYY-MM-DD"` and `"HH:MM"`. Schedules are stored in local terms so that 8:00 stays 8:00 across DST. The instant is computed from the household's IANA region timezone in `lib/time.ts`, which has no dependency. Weekdays are ISO numbers, 1 = Monday.
- **User ids** are Clerk user ids (the identity's `subject`). A senior device is also a Clerk user, created at pairing with `public_metadata.sunny_kind = "device"`.
- **View shapes use `null`.** Results built for the apps (`calendar.dayView`, `listEvents`, `instances.today`, `confirmDueTask`) return `null` for an absent optional value and never leave the key out. Raw document returns keep Convex's shape, which omits the field.
- **Uniqueness is kept by code.** Convex has no unique constraints, so the mutation that writes a row first looks its key up through an index. Serializable transactions make this check-then-insert safe. The unique keys are:
  - one instance per task, local date and time;
  - one join code per value;
  - one connection per caregiver per household;
  - one verification per member;
  - one digest per household and local date, and so one digest chat post;
  - one sync per event and connection;
  - one `agentToolCalls` row per request and tool use id;
  - one `eventNotices` row per event and date.
- **Actor model.** `actorKind` is `caregiver`, `senior_device`, `agent` or `system`. Every write path records who acted (`createdVia`, `confirmedVia`, audit rows).
  - The household agent's actor also carries the caregiver it acts for (`onBehalfOf`) and its request (`requestId`). `actorUserId` returns that caregiver, so what the agent creates has `createdBy` = the requester, and its audit rows have `actorUserId` = the requester and carry `detail.requestId`. The voice agent carries neither.
  - Public functions resolve the caller through `lib/access.ts` (`requireReader`, `requireEditor`, `requirePrimary`, `requireSenior`) and reject device identities in every caregiver check. Backend-only work is an `internal*` function.
  - The Python voice agent calls `agent:*` functions with `SUNNY_AGENT_KEY` as the first argument, and it may pass `now`. Public functions never accept `now` from clients.
- **Deletes.** Events are soft deleted (`deletedAt`) so that cancellations sync to Google. Tasks are hard deleted through `tasks.remove` / `purgeTaskData`, which also remove their instances and notifications. There is no household delete yet.
- **Audit.** `lib/audit.ts` writes `auditLog` rows. The mutations that change audited tables call it explicitly; nothing writes audit rows automatically.

## Households and access

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `households` | The senior's profile and household settings: `seniorPreferredName`, `seniorFullName`, `timezone`, `digestTime`, `eventNoticeTime`, `shareTranscripts`, `backgroundPaused` (caregiver "stop"), `lastDigestDate` (skips the digest lookup after the day's digest), `weatherLocation` (free text, such as "Brooklyn, NY", that the voice agent's weather tool looks up; absent means none) | none | `households.create`, `households.update` and the household agent's `update_settings` (both through `lib/householdSettings.ts` `updateHouseholdCore`, which audits a real change as `update_settings`), `digest.ts` (`lastDigestDate`) |
| `householdMembers` | A caregiver in a household: `role` (`primary`, `member` edits, `viewer` read only), `displayName`, `phone` (E.164), `phoneVerifiedAt`, `pendingPhone` | `by_household_user`, `by_user`, `by_phone` (looks up the sender of an inbound SMS; callers also check `phoneVerifiedAt`) | `households.*` (create, redeemJoinCode, updateMemberRole, removeMember), `phone.ts` (phone fields) |
| `devices` | A paired senior device: `userId` (its Clerk user), `kind` (`senior_phone`, `home_display`), `name`, `lastSeenAt` (written by the device API at most every 5 minutes), `pairedAt`, `pairingNonce`, `tokenHash` (SHA-256 hex of its device token; never returned) and `tokenIssuedAt`, `screen` (`{ width, height, greys }`) and `firmware` (reported by the device) | `by_user`, `by_household`, `by_token_hash` | `households.pairDevice` (internal, called by `pairing.ts` `/pair`), `removeDevice`, `deviceApi.ts` (token, `lastSeenAt`, `screen`, `firmware`) |
| `pushTokens` | Raw APNs tokens per user: a paired device's, or a caregiver's (the caregiver app registers once the caregiver has a household, and unregisters on sign-out or when notifications are turned off) | `by_user`, `by_token` | `households.registerPushToken` / `unregisterPushToken` |
| `joinCodes` | One-time 8-character codes for pairing a device or inviting a caregiver: `grants`, `createdBy`, `expiresAt` (24 h), `redeemedBy`, `redeemedAt` | `by_code`, `by_household` | `households.createJoinCode`, `redeemJoinCode`, `pairDevice`, `deleteJoinCode` |

Rules:
- A caregiver belongs to at most one household. `households.create` and `redeemJoinCode` reject a caller who already has a `householdMembers` row ("invalid"). The check runs before anything is inserted, so a rejected redeem leaves the code unused. A caregiver removed by `removeMember` can then create or join another household. Code enforces this rule, not an index, and older rows may still hold two memberships.
- A household always keeps at least one primary: the last primary cannot be demoted or removed.
- A device's `userId` is a Clerk user made at pairing. Re-pairing creates a new user, so a push token held by an orphaned user (no device row, no membership) may be taken over.
  - Between caregivers, a token moves to whoever registers it last. One phone has one token, and the newest caregiver to sign in on it holds that token. An earlier caregiver whose sign-out could not unregister the token therefore stops getting that household's pushes on that phone.
  - A paired device's token never moves, and a device never takes a live caregiver's token (`households.registerPushToken`).
- Takeover lets a caregiver who knows another caregiver's raw APNs token move it to their own account. We accept this because:
  - the token is never shown to other users;
  - APNs still delivers only to the physical phone that owns it;
  - the previous owner's rows then reach them by SMS, or not at all without a verified phone, as for anyone without the app;
  - nothing can be read through a token.
- `pairingNonce` and `pairedAt` let a device retry a lost `/pair` response for 10 minutes. `listDevices` strips the nonce and `tokenHash`.
- A device token is `sunny_dev_` plus 32 random bytes, base64url. It is made only in an action and stored only as its hash. Issuing a new token replaces the hash, at most 10 times an hour. `households.revokeDeviceToken` (editors only, audited `revoke_device_token`) clears the hash and keeps the device paired; removing the device deletes the row. Either one revokes the token at once.
- Removing a member drops their Google connections, links and pending syncs, and revokes the grants.
- Every workflow step and workpool job, the scheduler and the digest read `backgroundPaused`. Resuming (`households.update`) pushes the calendars again.

## Device API

The device API serves senior surfaces that cannot hold a Clerk session: the iOS widget and Live Activity, and the e-ink display firmware. Code: `deviceApi.ts`, `lib/deviceToken.ts`, `lib/deviceState.ts`, `lib/deviceWording.ts`, `lib/escalation.ts`.

- A signed-in senior device calls `deviceApi.issueToken` (an action, audited `issue_device_token` without the token) and gets `{ deviceToken }` once.
- Every request sends `Authorization: Bearer <deviceToken>`, and every response has `Cache-Control: no-store`. Every route answers with no-store JSON, an unexpected 500 included.
  - A missing, malformed or unknown token gets 401 with one fixed body. Firmware should then stop polling and ask to be paired again.
  - While the global bucket for failed authentications is empty (someone sent 60 bad tokens in the last minute), a revoked device gets 429 instead of 401. Firmware should therefore also give up and re-pair after repeated 429s on the same token.
- `GET /device/state` returns the device state with `ETag: "<version>"`. A request with that tag in `If-None-Match` gets 304 and no body.
- `GET /device/frame?page=now|today&format=png|packed` (`deviceFrame.ts`) draws the token's own device state for that device's `screen`, which is 960 x 680 with 4 greys until the device reports one. It returns `image/png` or the packed firmware format (`application/octet-stream`, described in `notes/HANDOFF.md` "Display frames"). The pages and their interval are the state's `tuning.carousel`.
  - `ETag` hashes the page's model (only what is drawn), the screen, the format and the renderer version. A match gets 304 before anything is drawn.
  - Every 200 and 304 carries two headers. `Sunny-Done-Instance` is the task that a Done press acts on while that frame shows. `Sunny-Done-Step` is the 0-based step that the frame shows ("0" for a task without steps). Both are absent when Done acts on nothing, including when the task is inside its early hour. The headers follow the frame's rule (the due Now task only), while the state's `done` follows the phone's rule and can be a task in its early hour, so a state response can carry a `done` without the headers. `GET /device/state` and the `POST /device/confirm` response carry the same two headers, and the state's `done` object has `step`.
  - The route answers 400, after the token check, to a missing, unknown or repeated `page` or `format`, to any other parameter, and to a stored screen outside 478 x 334 to 2048 x 2048 pixels (`lib/frame.ts` `DRAWABLE_SCREEN`).
- The hardware Done key sends a `POST /device/confirm` with `via: "button"`. If the task belongs to the household and was not due yet when pressed, the press is refused ("This task is not due yet"), audited `press_not_applied`, and counted against the same budget as the other refusals. Not due yet means an open task pressed more than 5 minutes (`BUTTON_EARLY_GRACE_MS`) before its `windowStart`, judged by the press time; the 5-minute grace allows for a drifting device clock. Other `via` values keep the 60-minute early rule.
- `POST /device/confirm` takes `{ instanceId, pressedAgoMs, via, step? }` and calls `instances.confirmPressedInstance` as the device. It answers 200 `{ status: "confirmed" | "advanced" | "rejected", reason, state }`.
  - `via` is `button`, `widget`, `live_activity` or `phone_app`. `step` is a whole number from 0 to 49, else 400. `pressedAgoMs` is 0 to 7 days, and bodies are at most 4096 characters. A bad body or id gets 400.
  - A press whose `step` is not the instance's current step changes nothing. It answers `advanced` with the current state, and is audited `press_not_applied` ("The task is not on the step that was pressed", with `pressedStep` and `currentStep`). A press without `step` acts on the current step.
  - The state is read after the press, in its own query. If that query fails, the press still stands and `state` is null, and the device then calls GET.
  - Another household's instance gets exactly the answer a deleted one gets.
- Refused presses are audited as `press_not_applied`, with the device as the actor and `transport: device_api`. They are:
  - everything that `confirmPressedInstance` refuses: a deleted instance, a press that is too early, a press outside the replay window, and a press made before a take-back;
  - what the device API refuses before calling it: an unreadable body, a bad instance id, and a press over 7 days old;
  - another household's instance. The core refuses it with its household check, which every confirm goes through. The device API answers it like a deleted one and records the row in the device's own household without that id; the raw id text is never stored.

  At most 20 refusal rows an hour are written per device, the core's rows included. Past that, the answer stays the same and no row is written.
- A confirm through the device API is a device confirm like the app's: the state is `confirmed` and `confirmedBy` is the device's user, so a caregiver's reopen stamps `confirmTakenBackAt`. The phone app's Undo (`undoPressedTask`) requires a press id, and a device-API confirm has none, so the phone cannot take it back (it answers `too_late`). The device API itself has no undo: the display and the widget offer none (`notes/SPEC.md`).
- `PUT /device/info` takes `{ screen?: { width, height, greys }, firmware? }`. Width and height are whole numbers from 1 to 10000, greys 2 to 256, and firmware 1 to 40 characters after trimming. Any other field gets 400. Success is 204.
- Rate limits: 120 requests a minute per device. Failed authentications spend from a global bucket (60 a minute) and a per-IP bucket (10 a minute), and get 429 with `Retry-After` once either bucket is empty. A valid token is never refused because of other callers' failures.
- The device state is built by `lib/deviceState.ts`. A device signed in with Clerk gets the identical object from the Convex query `deviceApi.state`. Absent values are null. Its fields:
  - `version`: FNV-1a 64 of the content without `generatedAt`. It is the ETag.
  - `displayVersion`: the hash of only what is drawn (dates, header, now, done, nextUp, rows, rowsHidden). A panel repaints only when it changes, not when a cue time passes.
  - `generatedAt`, `seniorPreferredName`, `timezone`, `utcOffsetMinutes`, `localDate`, `header`, `dateLabel`, `fullDate`.
  - `now`: the Now card. It never says "all done" while a task today is missed.
  - `done`: the task that a Done press confirms. It follows the phone's rule, so it may be early.
  - `nextUp`.
  - `nextUpAfterDue`: Next up when only a due task counts as Now, which is the wall display's rule. An early Now task is then itself next.
  - `rows` and `rowsHidden`: the Today page. Each row is marked `now`, `done`, `missed` (dimmed), `past` (an event that is over, dimmed: after its end, or an hour after its start for an event without one) or `none`. Rows and Next up items carry `type`, which is the task's type or `event`.
  - `cues`: the sentence, the prompts sent, the snooze, and `promptTimes`, the instants in the next 24 hours at which the ladder will prompt. `promptTimes` comes from the scheduler's own timing code.
  - `notes`: up to 3 unexpired notes from email, newest first, each `{ id, text, receivedAt, expiresAt }`. They are in `version` and not in `displayVersion`, because no frame draws them yet. A note is one of Sunny's fixed sentences (`SENIOR_SENTENCES` in `lib/mailTypes.ts`): at most 160 characters and 2 sentences, no digits, and only characters the display typefaces draw, so a display can draw it later.
  - `tuning`: poll intervals and carousel.

## Tasks and instances

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `tasks` | A scheduled item: `type`, `title` (caregiver wording), `displayLabel`, `spokenPrompt`, `pillDescription`, `checklistItems`, `times`, `daysOfWeek`, `onceOn`, `startsOn`/`endsOn`, `windowMinutes`, `highPriority` (set through chat; a medication or a task with `highPriority` gets the ladder's caregiver alert), as-needed limits, `createdByKind`, `active`, `scheduleChangedAt` | `by_household`, `by_household_active` | `tasks.create` / `update` / `remove`, `instances.createSeniorReminder` / `cancelSeniorReminder` |
| `taskInstances` | One row per task per scheduled time per local date, with `windowStart`/`windowEnd`, `state`, confirmation fields (`confirmedAt`, `confirmedBy`, `confirmedVia`), `confirmReceivedAt` (when the server received a confirm held offline more than 5 minutes), `resolvedFromState` and `resolvedFromSnoozedUntil` (the state and snooze that any confirm replaced, kept for undo and reopen; the names date from the caregiver resolve), `confirmTakenBackAt` (when a senior undo or caregiver reopen last took a confirmation back; a press made at or before it is refused) and `confirmTakenBackBy` (who did: the device's user for an undo, the caregiver for a reopen), `confirmPressIds` (the ids, from the phone queue, of the presses that make up the confirmation: the confirming press first, then the newest presses of the same device user that landed on it as no-ops, at most 4; cleared with the confirmation), `takenBackPressIds` (every take-back, whether a senior undo or a caregiver's reopen of a device confirm, appends all of `confirmPressIds`; newest last, at most 8), `resolutionNote` (why a caregiver resolved it), `snoozedUntil`, `claimedBy` and `claimedAt` ("I'm on it"), `createdAt`, `currentStep` (the step a multi-step task is on; absent means 0; a task is multi-step when `tasks.checklistItems` has 2 or more entries, `lib/taskSteps.ts`), `stepPresses` (one record per step advance: `step`, `at`, `by`, `pressId`), and `firedSteps` (escalation steps already handled, by step id, with a snapshot of the action and whether anyone was notified) | `by_task_date_time` (uniqueness), `by_household_date`, `by_task_state`, `by_household_state` (the tick reads one household's instances by state) | `scheduler.ts` (expand, open, escalate, close), `instances.ts` (confirm, snooze, claim, resolve, senior undo, reopen), `tasks.ts` (resync on schedule change) |
| `doseLog` | As-needed medication taken outside a scheduled instance. `loggedAt` (when it was written down), `conversationId` (the voice conversation that reported it), `undoneAt` (taken back: the row is kept and never counted) | `by_household_task_taken` | `instances.logDose`, `agent.logAsNeededDose` (voice, through the same `logDoseCore`; only `tasks.isAsNeededTask` medications; a report made while a dose was written down in the last 30 minutes, or one claiming a time within 30 minutes, is not logged unless `another`), `agent.undoLastDose` (marks `undoneAt` on a dose that this same conversation logged in the last 30 minutes, audited `undo_dose`). Every reader (status, limits, repeated use, context, digest facts) leaves undone rows out |

State machine (`instanceState`):

```
upcoming --(window_start)--> due --(caregiver alert step fires)--> escalated
   |                          |                                      |
   +--(confirm, <=60 min early)+--(confirm)--> confirmed <--(confirm)-+
                              |                                      |
                              +--(window_end, unconfirmed)--> missed <+
due / escalated / missed --(caregiver marks done)--> resolved
missed --(senior confirms late)--> confirmed (late = confirmedAt > windowEnd)
confirmed --(the same senior device undoes, <=60 s after the server recorded it)--> the state before the confirm
confirmed / resolved --(editor caregiver reopens, confirmed today)--> upcoming | due | escalated | missed, by the clock
```

Rules:
- `instances.ts` is the single write path for every surface. A senior device or the agent produces `confirmed`; a caregiver produces `resolved` with `confirmedVia = caregiver`. Confirming an instance that is already confirmed or resolved returns the original result.
  - The audit detail of a confirm says how it arrived: `transport` is `app` for the app's mutations and `device_api` for the HTTP device API, and it is unset for the voice agent.
  - `confirmDueTask(household, via, label?)` is what the Done button, the widget and voice call. It returns a status (`confirmed`, `already_done`, `nothing_due`, `not_found`, `ambiguous`, `not_due_yet`), so the double-dose guard lives in one place.
- Every confirm records the state and snooze it replaced in `resolvedFromState` and `resolvedFromSnoozedUntil`, whether the confirm came from a device, the agent or a caregiver. The names date from the caregiver resolve.
- **Senior undo** (`instances.undoPressedTask`, senior devices only). `confirmPressedTask` and `undoPressedTask` require the press's `pressId`. The phone shows Undo for 30 seconds; the server allows `SENIOR_UNDO_MS` (60 s), so a slow network never refuses a press that the senior was offered. Undo needs all of:
  - state `confirmed`;
  - `confirmedBy` equal to this device's user id, so not a confirm by another device, the voice agent or a caregiver;
  - `now - (confirmReceivedAt ?? confirmedAt) <= SENIOR_UNDO_MS`. This is measured from when the server recorded the confirm, because an offline press carries an earlier `confirmedAt`;
  - the task still runs (the same test as reopen); otherwise the answer is `too_late`.

  A press that took 1 to 5 minutes to arrive has no `confirmReceivedAt`, so its window is measured from `confirmedAt` and it arrives already past 60 s. We accept that: the phone's Undo has expired by then.

  Undo restores the prior state and the snooze, and clears the confirmation fields. When no prior state was recorded, it sets the state by the clock, as a reopen does. It is audited as a `state_change` with `undo: true`. Any failed condition returns `{ status: "too_late" }` and changes nothing. Undo never throws for a late tap; it throws only `forbidden`, when the caller is not a senior device or the instance belongs to another household. The caregiver's own 30 s `undoResolve` applies only to `resolved`, so it cannot touch a device's confirm.
- **Caregiver reopen** (`instances.reopenTaskInstance`, editors only; the home display has no undo). Viewers, devices and other households get `forbidden`. For an editor, reopen is allowed when all of these hold:
  - the state is `confirmed` or `resolved`, whoever confirmed it;
  - either the household-local date of `confirmedAt` or the instance's own `localDate` is today's. The second case covers a 00:30 task confirmed at 23:45 the evening before. Otherwise the answer is `invalid`;
  - the task must still run, i.e. exist, be active, and still be timed at that time (or anytime, to match). Otherwise the answer is `invalid` "This task is no longer on the schedule.", because deactivating or editing a task deletes only its open instances.

  The new state follows the clock (`lib/confirmRule.reopenedState`). Before `windowStart` it is `upcoming`. Inside the window it is the recorded prior state if that was `due` or `escalated`, else `due`. At or after `windowEnd` it is `missed`. Anytime instances never escalate, so inside their window they reopen as `due`, and after it as `missed`. Reopen clears the confirmation fields and `resolvedFrom*`, keeps the note and any claim, and restores no snooze.

  Reopen is audited as a `state_change` with `reopen: true` and the previous `confirmedAt`, `confirmedBy` and `confirmedVia` (the previous state is `from`). The day view's `reopenable` flag (`TodayEntry`) uses the same rule for time, state and whether the task still runs (`caregiverCanReopen` and `taskStillRuns`), so the app never offers a Reopen that will fail. The mutation checks the role.
- **Take-back stamp.** An Undo of a confirmation, and a reopen of a device confirm, set `confirmTakenBackAt` to `now` or to the offline tap time. `confirmInstance` then refuses (`invalid`) a press that carries an age and whose press time (`now` minus the age) is at or before the stamp. A press that the device's durable queue still holds after its acknowledgement was lost therefore cannot confirm the task again. Through `confirmPressedTask` this is `{ status: "rejected" }` with the usual `press_not_applied` audit row.
  - A press without an age (the home display's live confirm, voice, a caregiver's Mark done) is not checked against the stamp, since it is by definition made now. A press made after the take-back confirms as usual.
  - A reopen stamps only a device or voice confirm (`confirmed`), not a caregiver's `resolved`, because nothing was taken back from the senior.
  - An Undo tapped offline carries `undoneAgoMs`. The 60 s rule is judged at the tap time, and the stamp is the tap time clamped to between `confirmedAt` and now. A Done pressed after the Undo tap therefore still applies when it is delivered later.
- **Alerts after an undo or reopen.** A caregiver alert that was skipped as `instance_closed` while the instance was done is not sent again. The ladder continues: steps in `firedSteps` are not repeated, and unfired steps fire when due. A reopen late in the window can fire an overdue step on the next tick; only the latest of each kind notifies.
- The scheduler tick (`scheduler.ts`, every minute) fans out one `tickHousehold` per household. Each one:
  - expands today and tomorrow. Expansion is idempotent through the `by_task_date_time` lookup, and a window that already closed is skipped unless the task existed when it opened;
  - opens windows;
  - fires each due escalation step once and records it in `firedSteps`. When several steps of one kind come due together, only the latest is sent and the rest record `notified: false`. A caregiver alert goes to every caregiver of the household;
  - marks instances with a fired caregiver alert `escalated`;
  - closes windows to `missed`.

  Offsets count from the later of `windowStart` and `createdAt`. Snoozes defer senior prompts only.
- **Alert when a window closes.** A window can close before any caregiver was alerted, when the alert step falls due at or after the window's end. That happens with a short window, or with a task added late in its window, since offsets count from the later of window start and creation. Such a window still alerts every caregiver as it is marked missed. The first unfired caregiver-alert step of the ladder that no claim holds is recorded as fired and notified, and the alert ("Due at 8:00 AM. Its time has now passed.") goes through the usual outbox path, so "I'm on it" and the claim work on the missed instance. Nothing is sent when:
  - a caregiver alert was already notified;
  - the ladder has no caregiver alert;
  - the task is inactive or alerts no caregiver (neither medication nor high priority);
  - the instance is anytime;
  - a claim holds the only unfired alert;
  - the instance was created at or after its window's end. That is expansion after an outage, and the senior never had a chance at the task;
  - the window ended more than 60 minutes before the tick that closes it, which means the scheduler was down. No batch of stale alerts is sent while presses queued offline may be about to arrive. The task is still missed and still in the digest.

  `fireSteps` skips windows that have ended, so the two paths never both alert one instance in a tick.
- Editing a task's schedule or the household timezone deletes future `upcoming` instances and re-expands. Deactivating a task removes its open instances.
- The ladder is the same for every household and lives in `lib/escalation.ts`. Medications and tasks with `highPriority` get three steps: `prompt` at 0 minutes, `prompt_again` at `PROMPT_AGAIN_MINUTES` (15), and `alert` at `ALERT_MINUTES` (30), which alerts every caregiver at once; anyone who may claim can claim it. When the window closes the instance is marked missed, and if no alert went out before then, the close sends one. Every other timed task gets `prompt` only, is marked missed at close, and never alerts a caregiver. Anytime and inactive tasks get no steps. `firedSteps` records the step ids, so each step fires once per instance.

**Multi-step tasks** (`lib/taskSteps.ts`):
- A Done press from any senior surface (phone, iPad, `POST /device/confirm`, voice) on a step that is not the last advances `currentStep` instead of confirming. The advance is audited as action `step` with `fromStep` and `toStep`, and answers `status: "advanced"`. Done on the last step confirms as usual. A replayed press id that already advanced is a no-op. A caregiver's Mark done resolves the whole task.
- Senior Undo of an advance goes back one step. It needs the same device, the press's id, and 60 s from when the server recorded the press, and it appends that id to `takenBackPressIds`. It does not set `confirmTakenBackAt`, so a queued press from another device is judged by the step it names. A caregiver reopen leaves the step where it was. Advance and Undo both apply in any state that is not done, `missed` included.
- Every senior surface sends the step it showed: the phone queue stores it, the iPad sends it, and voice passes the step it read. A press for a step that the task has left is a no-op, so a double press, a replay, or two surfaces pressing together advance the task once.
- A step advance clears `snoozedUntil`.
- When a caregiver changes a task's `checklistItems`, an instance that is not done and has step progress goes back to step 0. This applies to today's instance and to yesterday's instance if it is still due. Its `stepPresses` is cleared, its press ids join `takenBackPressIds`, and the restart is audited as `step` with `restart: true`.
- The task stays open until the last step, so prompts and alerts keep firing, and every prompt and cue sentence appends "Step N of M: text."
- The day view's `TodayEntry` carries `step` (`index`, `count`, `text`, or null) and `stepPressIds` (only the step presses of the senior device that is reading). The device state's `now.task.step` carries the same step, so `version` and `displayVersion` change with it.
- A press that names a step the instance has left answers `advanced` with the current state even though nothing changed, so a client that pressed twice simply shows the step the task is on.

- The size and blank-value rules for tasks live in `lib/taskDraft.ts` and apply to both ways a task is created: `tasks.create` (the caregiver app and the agent's `add_task`) and `instances.createSeniorReminder` (a reminder the senior sets by voice). A senior reminder keeps its full title and spoken prompt, and its display label is clipped at a word to 60 characters with "…".

## Calendar and Google sync

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `events` | Appointments and visits in household-local terms: `title`, `label` (gentler wording for the senior), `startsOn`, `startTime`, `durationMinutes`, `place`, `visitorName`, `notes`, weekly repeat (`repeatDays`, `repeatUntil`), `createdVia`, `deletedAt` | `by_household`, `by_household_deleted` | `calendar.ts` (`addEvent`, `updateEvent`, `cancelEvent`), the agent's tools (same functions) |
| `eventNotices` | An occurrence already announced to caregivers (one per event per local date) | `by_event_date` | `lib/eventNotices.ts`, from the household tick |
| `calendarConnections` | A caregiver's Google connection: `userId`, `accountEmail` (lower case), `externalCalendarId` (the Sunny-owned calendar), `status` (`active`, `revoked`, `error`), `error`, encrypted `refreshToken`, cached encrypted `accessToken` and `accessTokenExpiresAt`, `lastSyncedAt`, `lastError` | `by_household_status`, `by_household_user`, `by_account` (is a Google account still in use before revoking its grant) | `googleCalendar.saveConnection`, `calendarPush.ts` (`lastError`), `googleGrant.saveToken` (token cache), `googleGrant.markGrant` (status), `disconnect` |
| `calendarEventLinks` | Our event to the Google event, per connection: `externalEventId`, `etag`, `syncedAt` | `by_event_connection`, `by_connection` | `calendarPush.recordPush`; removed on disconnect and on a confirmed deletion |
| `calendarSyncs` | The pending push of one event to one connection: `state` (`queued`, `running`, `dirty`), `updatedAt`, `failures` | `by_event_connection` (uniqueness), `by_connection`, `by_updated` (sweeper) | `lib/calendarSync.ts` (queue), `calendarPush.ts` (begin, complete), `calendarFanOut.sweepStuckSyncs` |
| `oauthFlows` | One Google consent flow, bound to a browser: `ticketHash` (SHA-256 of the one-time start ticket), `userId`, `householdId`, `purpose` (`calendar` or `mailbox`), `expiresAt` (5 minutes until started, then 10), `started` (`browserHash` of the cookie secret and the encrypted PKCE `codeVerifier`), `consumedAt` | `by_ticket`, `by_expires` | `googleOauth.connectUrl` creates it, `GET /google/start` starts it, the callback consumes it, swept hourly by `googleOauth.sweepOauthFlows` |

Rules:
- Occurrences are computed (`lib/occurrences.ts`), not stored. Repeats are weekly only.
- Cancelling is a soft delete (`deletedAt`); clients cannot hard delete events.
- A `calendarSyncs` row exists only while a push is pending, which is how repeated edits merge into one push. The transitions are in `lib/calendarSync.ts` and `calendarPush.onPushComplete`: `queued`, `running`, `dirty`, deletion on completion, the one delayed retry after retries run out (counted in `failures`), and the 15-minute sweeper. While the `calendar` service hold is open a push is not started and the row stays as it is; a probe push that ends in the hold goes back to `queued`. Neither touches `failures`, so the row needs no held count of its own, unlike `mailItems.heldClaims`, where every claim adds to `attempt`.
- Refresh and access tokens are AES-GCM boxes (`lib/secretBox.ts`) keyed by `CALENDAR_TOKEN_KEY`, and they are never returned to clients. Rotating the key means caregivers reconnect.
- `saveConnection` keeps one connection per caregiver per household by reactivating the existing row.

## Gmail

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `mailboxes` | The senior's Gmail, one per household: `connectedBy`, `accountEmail` (lower case), encrypted `refreshToken`, cached encrypted `accessToken` and `accessTokenExpiresAt`, `status` (`active`, `revoked`, `error`), `error`, `historyId` (the poll cursor), `lastPolledAt`, `lastError`, `pollJobId` (the workpool work id of the last poll `pollAll` enqueued; `pollAll` enqueues no new poll while that job is pending or running). `pollJobId` is optional because rows connected before it existed have never been polled under it; every row that `pollAll` has reached has one. `heldNoteFor` (the `mailHeldSince` of the mail outage whose "Sunny can't read mail right now" note this mailbox got; `serviceHolds.noteMailHeld` and `saveMailbox` post the note only when it differs, so a mailbox gets one note per outage) is optional because a mailbox that has never been noted has no outage to record | `by_household`, `by_status`, `by_account` (is a Google account still in use before revoking its grant) | `gmail.saveMailbox`, `recordNew` (cursor), `pollAll` (`pollJobId`), `serviceHolds.noteMailHeld` and `noteIfMailHeld` (`heldNoteFor`), `googleGrant.saveToken`, `googleGrant.markGrant`, `disconnect` |
| `mailItems` | One Gmail message: `account` (the mailbox address when it was found), `gmailId`, `state` (`queued`, `triaging`, `done`, `failed`), `attempt` (claims so far), `heldClaims` (claims that ended in a service hold, an error that is the same for every row, such as a missing `TYPESAFE_API_KEY`, Google's daily project limit or an API disabled for the Google Cloud project; only a probe claim can end that way, since no row is claimed while a hold is open; a probe claim that fails because a held service is still unavailable (a Jev 5xx, 429 or lost connection while the `jev` hold is open, a Gmail 5xx or 429 while the `gmail` hold is open) counts here too, and any other failed claim does not; the claim after 10 claims that were not held fails the row), `leaseUntil` (the pickup deadline while `queued`, the lease while `triaging`), `jobId` (the workpool work id of the triage job that holds the row; `onMailJobComplete` acts only for that job). After parsing: `sender` (`name`, `address`, `authenticated`), `subject`, `receivedAt`. After triage: `verdict` (the verdict kind), `rule` (the id of the decision-table row that fired, or `gone` / `unparseable`; ids are listed in `notes/AGENT_RUNTIME.md` "Gmail", and rows from before the ids hold prose), `judgeRule` (the id of the truth-table row that fired, or `gate:<rule>` when the gate settled the email), `judgeAnswers` (Jev's answer to each question by id: a Noul as its probability, a Choice as `{ choice, probability }`; absent when the gate settled it), `effects` (records: `event_added`, `event_rescheduled` with `fromDate` and `fromTime`, `already_on_calendar`, `senior_note` with `noteId`, `told_caregivers` with `pushed`, `escalated` with `reason`, `pushed`, an optional `eventId` and an optional `proposed` `{ kind, date, time }` (the appointment the email asked for, checked as a date and a time)), `escalatedAt` (when `applyTriage` recorded an escalation), `calendarChangedAt` (when `applyTriage` recorded an `event_added` or `event_rescheduled`; at most 5 per household per local day), `classifier` (`name`: the Jev model, or `gate`; token `usage`), `caregiverPost` (when triage posted to the caregivers: the `postId` and Sunny's `line` in it, so the post can be rendered again when Claude Haiku's summary arrives) | `by_household_account_gmail` (dedupe), `by_state_lease` (sweeper), `by_household_received` (recent mail), `by_household_escalated` (briefing), `by_household_calendar_changed` (the daily cap on calendar changes from mail) | `gmail.ts` inserts; `mailTriage.ts` moves it through its states |
| `seniorNotes` | A short note for the senior from an email: `mailItemId`, `text` (one of Sunny's fixed sentences, never email text), `receivedAt`, `expiresAt`. At most 3 are written per household per local day | `by_household_received` (the newest unexpired notes), `by_household` (the notes written today, by creation time, for the daily limit in `mailTriage.ts`) | `lib/mailEffects.ts` (`senior_note`); read by the device state and `agent.getContext` |
| `mailEventLinks` | An event and an appointment key an email gave it (`ics:<UID>`, or `appt:<date>:<time>:<title>` with Sunny's title for the appointment kind), with `senderDomain` (the From domain of the verified sender that wrote the link), `senderAddress` (that sender's whole address, set when the link is inserted and kept when a later email from the domain points it at another event), the `mailItemId` that wrote it, and the invite's `sequence` for an `ics:` link. One row per household, domain and key; an event can hold links from several domains. A link is read and changed only for verified mail from its own domain; a resent invite with the same key raises `sequence` | `by_household_domain_key` | `lib/mailEffects.ts` (`add_event`, `reschedule_event`, `already_on_calendar`) |

| `serviceHolds` | One row per service (`gmail`, `calendar`, `jev`) that a deployment-wide failure has held: `open`, `since` (when the job whose failure opened the latest hold started), `error` (that failure, at most 2000 characters, for the logs and the dashboard; never shown to caregivers), `openedAt`, `probeAt` (when the next probe may start), `closedAt` (when a probe last closed it; a failure from a job that started at or before it does not reopen the hold), `mailHeldSince` (on a `gmail` or `jev` hold: when mail stopped being read in the outage this hold belongs to, which is its own `openedAt` when no other mail hold was open, or the other open hold's value; it names the outage for `mailboxes.heldNoteFor`. Absent on a `calendar` hold, which does not stop mail, and on mail holds opened before the field existed, for which `openedAt` stands in). The row is kept after it closes and reused by the next hold | `by_service` | `serviceHolds.open` and `close`; `probeAt` by the gates in `lib/serviceHolds.ts` (`beginPoll`, `claimItem`, `calendarPush.begin`) and by `mailTriage.probeAgain`, which makes the `jev` probe due again after a triage probe that did not call Jev |

Rules:
- The email body is never stored, and no text from an email or a model is stored as a senior note, an event title or an event place. The subject is cut to 200 characters. The caregiver summary from Claude Haiku is stored only inside the `chatPosts` body.
- No effect is written outside the mutation that moves an item to `done` (`applyTriage`) or `failed` (`onMailJobComplete`), and every write after the claim requires the same `attempt`. That transaction is what makes each effect happen once; there is no separate effect ledger.
- A link is kept after its event is cancelled, and items are kept after a disconnect. Both stop Sunny from acting twice on the same appointment or message.
- Gmail flows: `notes/AGENT_RUNTIME.md` "Gmail".

## Notifications and delivery

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `notificationOutbox` | The only place notifications are queued. One recipient per row: `recipientDeviceId` (APNs) or `recipientUserId` (a caregiver: APNs when they have a push token, else SMS). `kind` (`senior_prompt`, `caregiver_alert`, `event_notice`, `digest`, `agent_flag` (the voice agent asking a caregiver to look in; `payload.reason`, `payload.flaggedAt`), `family_message` (a message the senior dictated to family), `senior_note` (a note from an email, to senior phones only; `seniorNoteId`), `mail_escalation` (an email that needs a caregiver, or lost access to the mailbox), `mail_update` (Sunny changed the calendar from an email)), `seniorNoteId` (skipped as `note_expired` once the note has expired), `title`, `body`, `payload` (a digest row's `pushTitle` is the push title, and `title` stays the SMS's), `state` (`pending`, `sent`, `skipped`, `failed`), `channel` (set only when sent: what actually delivered it), `settledAt`, `attempts`, `attemptStartedAt` (lease), `detail` (skip reason or internal error, never returned to clients), `pushState` (on a caregiver push that has a text to fall back on: `retrying` after a retryable push failure, `gave_up` once the push retries ran out and the row was enqueued again to be texted) | `by_recipient_kind` (reply-to-claim), `by_recipient_device`, `by_task_instance` (cascade on instance delete), `by_household`, `by_state` | Inserted only through `insertNotification` in `lib/delivery.ts` (scheduler, event notices, digest, `lib/voiceRouting.ts` for agent flags and family messages, `lib/mailEffects.ts` and `googleGrant.markGrant` for mail); settled by `delivery.ts` |
| `smsInbound` | Inbound texts already handled, by Twilio `MessageSid`, with the stored reply, so that a webhook retry claims nothing twice | `by_sid`, `by_expires` | `sms.ts`; swept hourly |

Rules:
- A row leaves `pending` once. Recipient, membership and content are checked again at send time, so a row that has gone stale or whose recipient is unreachable is `skipped`, with the reason in `detail`.
- **Push first for caregivers** (`lib/delivery.ts`). A member row goes by APNs when the member's user has at least one `pushTokens` row (the caregiver app with notifications on), and otherwise by SMS exactly as before. The rule: a caregiver who would have been texted before push existed never ends up with nothing.
  - When APNs is not configured, or takes none of the tokens and nothing is worth retrying (every token unregistered, which deletes it, or refused for good), the same row is sent as the member's SMS in the same run, so it settles with `channel` `sms`.
  - A retryable APNs failure is retried, not texted, and marks the row `pushState: "retrying"`. When the workpool's retries run out and the member has a verified phone, `delivery.onDeliveryComplete` sets `gave_up` and enqueues the row once more, and its route is then the SMS (`lib/delivery.ts` `textAfterPushGaveUp`). This happens once per row.
  - Without a verified phone, a push that cannot be delivered ends as a device push does: `skipped` (`tokens_unregistered`), `failed`, or pending while APNs is not configured.
  - Pushes carry data `notification_id`, `kind`, `household_id` and `task_instance_id` (when there is one). `caregiver_alert`, `agent_flag` and `mail_escalation` to caregivers and `senior_prompt` to devices are time-sensitive (a table keyed by kind in `lib/apnsPayload.ts`). A `caregiver_alert` to a primary or member has the `caregiver_alert` category ("I'm on it"), and a viewer's has none. The collapse id is the task instance (`lib/apnsPayload.ts`).
- A caregiver is reachable, and so gets queued flags, family messages and digests, when they have a verified phone or at least one push token (`isReachableMember`).
- `attempts` is capped (`MAX_ATTEMPTS`) so that the sweeper never loops on one row, and `attemptStartedAt` is a 5-minute lease that the sweeper respects. The text sent after a push gave up shares the row's budget, so a row that reaches the bound is failed, not texted.
- `agent_flag` and `family_message` rows go to caregivers like any member row. They are not tied to a task, so their texts never carry the "Reply 1" claim hint, and a "1" texted back after one of them claims nothing. That reply gets "Thanks. Nothing needs claiming for that message."
  - Rows are queued only for reachable caregivers. An `agent_flag` goes to every reachable caregiver at once; there is no on-call caregiver. With nobody reachable, nothing is queued, the decision is audited, and the voice agent says family could not be reached.
  - Only an identical event is held back from repeating. A flag whose key went out within 10 minutes is not sent again, and for repeated as-needed use the interval is once a week. The key is the model's reason plus its detail text, or for a medication limit or repeated use, the reason and the task. That decision is audited too.
  - At most 12 symptom, money and scam flags are sent per household per hour. Distress, help_requested, medication limits, repeated use and dose corrections are never capped.
  - At most 10 senior messages are sent per hour. An identical senior message within 2 minutes is not sent again, and the agent says how the first one went.
  - Flag text is at most two sentences and 240 characters, with runs of 6 or more digits removed.
  - A text that timed out is retried only for `caregiver_alert`, `agent_flag` and `mail_escalation`.
- A `senior_note` row goes to a `senior_phone` device and never by SMS. Mail pushes to caregivers go to every reachable caregiver; escalations are capped at 6 per household per hour (`notes/AGENT_RUNTIME.md` "Gmail").
- Only tokens that APNs reports unregistered are deleted from `pushTokens`.

## Digests

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `digests` | One row per household per local date: `status` (`pending`, `done`, `failed`), `source` (`claude` or `template`), `text`, `error` | `by_household_date` (uniqueness), `by_status` (sweeper) | `digest.queueDigestIfDue` (from the tick), `compose` and `complete` (delivery pool) |
| `chatPosts` | A post from Sunny in the household's one caregiver chat thread. One of three shapes, each with `body` and `localDate`: `kind` `digest` with `digestId`; `kind` `mail` with `mailItemId` and an optional `mailHeader` (what Sunny did with an email, or that it could not read one; the body holds only Sunny's lines and the caregiver summary, and `mailHeader` holds the email's sender, subject and received time as the app shows them, see below); `kind` `mailbox` (Sunny now reads an address, lost access to it, or cannot read mail while a service hold is open) | `by_household` (newest first by creation time) | `lib/chatPosts.ts`: `postDigest` from `digest.complete`, `postMail` from the mail effects and `onMailJobComplete`, `postMailbox` from `saveMailbox` and `googleGrant.markGrant` |

Rules:
- A paused household gets no digest until it is resumed.
- A household created after that day's digest time gets none that day.
- `delivery.sweepStuck` re-enqueues a digest left `pending` for 15 minutes.
- `complete` works in one transaction: it stores the text, posts it to `chatPosts` (for everyone), queues one `digest` outbox row per reachable caregiver (every caregiver, viewers included; there is no opt-out), and marks the digest `done`. A digest is therefore posted once, one per household per local date.
- A push shows "<name>'s day" over the text and opens the Chat tab. A caregiver without the app gets the full text by SMS ("Sunny: <name>'s day").
- Before the digests, the briefing lists the emails Sunny escalated in the last 3 days (at most 10). Each line holds only Sunny's own records: the received time, the reason, the `mail_item_id`, the domain of the sender's address (never the local part), and, when one matched, the event's `event_id`, title, date and time from `events`, and the proposed appointment's title, kind, date and time. No subject, sender name or summary reaches the chat agent.
- The household agent's briefing ends with the `done` digests of the household's local today and yesterday (`lib/agentBriefing.ts`): one line each, at most 600 characters, labelled as information and never as instructions. This lets the agent answer a reply to the digest in the chat.

## Agent requests

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `agentRequests` | A caregiver's request to the household agent: `requestedBy`, `message`, `continueRequestId`, `status` (`queued`, `running`, `succeeded`, `failed`, `cancelled`), `workflowId`, `sessionId` (Managed Agents), `baselineUserMessages`, `reply`, `error` (safe to show a caregiver), `errorDetail` (raw, never returned), `finishedAt`, `changedTaskIds` (tasks that its `add_task` and `update_task` calls changed, for the wording cards) | `by_household`, `by_household_status`, `by_session` | `agentRequests.ts` (request, cancel), `agentRuntime.ts` (workflow steps and completion) |
| `agentToolCalls` | One row per tool call for a request: `toolUseId`, `name`, `input`, result `text`, `isError`, `sentAt` | `by_request_tool` (uniqueness), `by_request_sent` | `lib/agentTools.ts`, in the same transaction as the tool's effect |

Rules:
- At most 5 requests per household are queued or running.
- A session has at most one request in progress.
- The message is 1 to 4000 characters.
- A continuation may only continue a succeeded request of the same household.
- Status transitions go through `lib/agentRequestState.ts`.

The chat thread that the app shows is `agentRequests.transcript`: requests and `chatPosts` merged by creation time, newest first. Each item is tagged `type` `request` (the request view) or `post` (`id`, `kind`, `body`, `localDate`, `createdAt`, `mailHeader`). The transcript holds at most `limit` items across both (default 20, at most 100).

`mailHeader` in the transcript is the `mailHeader` stored on the `chatPosts` row, or null when the row has none; the transcript reads no mail item or household for it. `postMail` stores it when it writes a `mail` post whose mail item has a sender, subject and received time, built by `lib/mailProse.displayHeader`: `senderName` (links and long numbers removed, null when blank), `senderAddress`, `senderVerified`, `subject` (links and long numbers removed, cut to 120 characters), and `receivedDate` and `receivedTime` in the household's timezone at that moment. Like the body, it is a snapshot of the moment the post was written, so a later change to the mail item or to the household's timezone does not change it. The field is optional: a `mail` post whose item had no header yet (Sunny could not read the email) has none, `digest` and `mailbox` posts have none, and neither do mail posts written before the field existed. The app draws the From, Subject and Received lines from it above the body, and labels a mail post without one "Mail". Mail posts written before the header moved out of the body (dev deployments only) still carry those three lines at the top of their body, and the app shows them as plain body text.

Every caregiver of the household may read it (`requireCaregiverReader`), and a senior device never may. A viewer gets the posts only, since requests and their replies stay editor-only, as in `list` and `get`.

Each request item also carries `wording`: one entry per task that its successful `add_task` and `update_task` calls created or changed. The task list is `agentRequests.changedTaskIds`, appended in the tool's own transaction, with each task once in order of first change and at most 20 tasks (`MAX_CHANGED_TASKS` in `agentRuntime.ts`). Each entry is read from the task as it is now:
- `taskId`;
- `label`, the display label;
- `time`, the display's clock form of the task's first time ("8:00"), or "Anytime";
- `times`, every time as "HH:MM", earliest first;
- `sentence`, what the display speaks at that time (`lib/deviceWording.ts` `cueSpeech`). It is null for a task with no time, which is never prompted.

A task that is stopped, deleted or in another household has no entry, and viewers get no requests and so no wording. The transcript reads only request rows and their tasks, never the tool call rows.

## Voice and agent memory

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `conversations` | One voice session: `trigger` (`talk`, `scheduled_prompt`, `notification_tap`), `deviceId`, `taskInstanceId`, `startedAt`, `endedAt`, `summary` | `by_household_started` | `agent.startConversation` / `finishConversation` |
| `conversationTurns` | What was said: `role`, `content` | `by_conversation` | `agent.logTurn` |
| `agentQuestions` | One row per question the senior asked: `topic`, `outcome`, `toolsUsed`; the digest counts repeats | `by_household_asked` | `agent.logQuestions` (idempotent per conversation). The voice agent calls it after each conversation with the questions that one model call extracts from the transcript (`sunny_agent/src/memory.py`). Topics are lower-cased, and the last week's topics are offered so that a repeat reuses its topic. The digest names unanswered and routed questions by topic unless `shareTranscripts` is true |
| `listItems` | The household's one shared list: `text` (one line, at most 80 characters), `addedByKind` (`senior`, `caregiver`), `addedBy`, `addedAt`, `doneAt`, `doneByKind`, `doneBy` | `by_household_done` (open items have no `doneAt`), `by_household_added` (digest) | Only `lib/householdList.ts`: `agent.addListItems` / `tickListItem` (voice, as the senior), `lists.add` / `untick` / `remove` (editor caregivers), `lists.tick` (editors and the household's devices). At most 50 open items; adding text that is already open (case-insensitive) adds nothing. Every change is audited (`list_add`, `list_done`, `list_undone`, `list_remove`). The digest has one line for items the senior added that day |
| `agentMemory` | Facts the agent knows: `fact`, `source`, `verifiedBy`/`verifiedAt`, `conversationId`. Senior-stated facts start unverified and never overwrite verified ones | `by_household`, `by_household_verified` | `profile.ts` (`addFact`, `verifyFact`, `correctFact`, `removeFact`); `agent.rememberFact` (source senior, unverified, one trimmed line of at most 300 characters; a duplicate text is skipped; the oldest unverified senior facts beyond 200 are deleted, audited `trim`); read by `agent.getContext` (the newest verified facts up to 40, then the newest unverified facts in the rest of 50, at least 10). Limits, reads, ordering and the duplicate key are in `lib/memoryLimits.ts` and `lib/profileReads.ts` (duplicate key: `lib/text.ts` textKey) |
| `lifeProfileEntries` | Caregiver-owned people, places, doctors, habits, interests, preferences | `by_household` | `profile.ts` (`addEntry`, `updateEntry`, `removeEntry`); read by `agent.getContext` |
| `sensitiveTopics` | Caregiver-written guidance for hard questions | `by_household` | `profile.ts` (`addTopic`, `updateTopic`, `removeTopic`); read by `agent.getContext` |
| `familyMessages` | Messages between family and the senior (text, photo or voice clip in `_storage`), `seenAt` | `by_household` | `profile.sendMessage` (caregiver text); `agent.sendFamilyMessage` (`senderKind` senior; there is no recipient field, so a named recipient is written into the body: "For Sarah: I'm home"); `agent.readLatestMessage` sets `seenAt` when the newest caregiver message is read aloud (loading the context never does); read by `agent.getContext` (newest caregiver message) and `profile.listMessages` |

Rules for the caregiver write path (`profile.ts`):
- The About tab's mutations and the household agent's knowledge tools (`get_knowledge`, `add_knowledge`, `update_knowledge`, `remove_knowledge`, `lib/agentSetupTools.ts`) call the same exported cores (`addEntryCore`, `updateEntryCore`, `removeEntryCore`, `listTopicsCore`, `addTopicCore`, `updateTopicCore`, `removeTopicCore`, `listMemoryCore`, `addFactCore`, `verifyFactCore`, `correctFactCore`, `removeFactCore`), so every rule below holds for both. A change made through chat is recorded under the requesting caregiver (`createdBy`, `verifiedBy`, the audit row's user), with the request id in the audit detail.
- Editors (primary, member) write.
- All four lists are caregiver only (`requireCaregiverReader` in `lib/access.ts`: any role, never a paired device), since what they hold is written about the senior and nothing on the senior's screens uses them. `requireCaregiverReader`, like every caregiver check, refuses a device by its token claim or by a `devices` row.
- `listMessages` returns `mine` for the caller's own messages, and no member ids.
- Every change writes an `auditLog` row (`lifeProfileEntry`, `sensitiveTopic`, `agentMemory`, `familyMessage`). The row for an update or a correction also holds the previous text (`detail.previous`), so a replaced value can be recovered.
- Text is trimmed and capped: name 120, details 600, topic 200, guidance 1500, fact 300, message 1000 characters. Everything except message bodies is one paragraph, with whitespace, line breaks included, collapsed.
- Counts are capped because `getContext` loads every entry and topic into each conversation, along with at most 50 facts (verified first, then newest). The caps are 150 entries, 30 topics and 40 verified facts, which leaves at least 10 places for the senior's newest unverified facts.
- Memory reads are bounded through `agentMemory.by_household_verified` (`householdId`, `verifiedAt`): the verified facts, and the newest unverified ones. `listMemory` returns `{ facts, olderUnverified }`: the verified facts, the newest 50 unverified, and a count of the older ones (up to 500). A fact's duplicate check covers the verified facts and the newest 500 unverified ones.
- Adds de-duplicate, case-insensitively: an entry by category and name, a topic by its wording, a fact by its text. They return `{ id, created, same, confirmed }`.
  - An existing row is returned unchanged. `same` says whether its text equals what was sent, compared exactly: an entry's name, and its details when details were sent; a topic's wording and guidance. The caller decides whether to update it.
  - Adding a fact that the senior already stated verifies it (`confirmed`).
  - Renaming onto another row's key is refused.
- Only an editor caregiver verifies a fact (`verifyFact`, which keeps the first verifier) or corrects it (`correctFact`, which verifies it and keeps the source).

Privacy: conversation summaries, question text and turns carry what the senior said, so caregivers can read them only when `households.shareTranscripts` is true. The digest reports topics and counts. `agent:*` functions require `SUNNY_AGENT_KEY`. The household always comes from the LiveKit participant metadata that the token action wrote, never from the model.

## Phone verification

| Table | Purpose and key fields | Indexes | Written by |
| --- | --- | --- | --- |
| `phoneVerifications` | The one outstanding verification per member: `phone`, `codeHash` (HMAC bound to user and number, absent until the code exists), `sendError`, `sendErrorDetail`, `expiresAt` (10 minutes), `attempts` (5 wrong guesses lock it) | `by_household_user` (uniqueness), `by_expires` | `phone.ts`: `setMyPhone` replaces the row, `sendCode` stores the hash, `confirmMyPhone` deletes it on success, `sweepExpired` (hourly) |

Rules:
- The code is made inside the send action and never stored or scheduled in plaintext.
- `households.myPhoneStatus` (implemented in `phone.ts` and re-exported from `households.ts`) lets a client wait for the send (none, sending, sent, send_failed, expired). It returns only the caller's own pending number.
- A failed send stores a `sendError` that is safe to show the caregiver (generic, or "That number cannot receive texts."), and the raw text in `sendErrorDetail`, which no function returns.
- `expired` is computed from `Date.now()` inside the query. Convex does not re-run the query as time passes, so a subscribed client should compare `expiresAt` with its own clock.
- Sends are rate limited per caregiver, per caregiver and number, and per day for each caregiver and household.
- Only verified numbers (`phoneVerifiedAt`) receive texts, and only in allowed countries (`SMS_ALLOWED_COUNTRY_CODES`, default US/CA).

## Audit

`auditLog`: `actorUserId`, `actorKind`, `action`, `entity`, `entityId`, `detail`. Indexes: `by_household`, and `by_household_action`, which the voice agent uses to read how an earlier family message went out. Written only by `lib/audit.ts`.

`agentFlags`: one row per voice agent flag that reached family: `reason`, `key`, `at`, `names`, `recipientUserIds`, `doseId` (the dose that a medication-limit flag was about, used for the correction when the dose is taken back), `conversationId`. Indexes: `by_household_key_at` (the repeat check) and `by_household_at` (the hourly cap). Written only by `lib/voiceRouting.ts`. Every flag decision is also an `auditLog` row (`flag_caregiver`).

## Not built yet

Storage rules for photos and voice clips (caregiver messages are text only), and a household delete.
