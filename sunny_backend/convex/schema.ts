// schema.ts
// Purpose: The shared household state every surface renders (see notes/SPEC.md "Shared
// state" and notes/CONVEX_MIGRATION.md). Ported from the Supabase migrations:
// households, caregiver membership and paired devices; join codes; escalation policies
// (steps embedded in order); tasks and their daily instances (fired escalation steps
// embedded on the instance); self-reported doses; the notification outbox; the audit
// log; calendar events and day-of notices; and what the agent reads: family messages,
// life profile, sensitive topics, agent memory and the conversation log.
// Conventions: instants are epoch ms; household-local dates are "YYYY-MM-DD" and local
// times "HH:MM"; weekdays are ISO numbers (1 = Monday); user ids are Clerk user ids
// (the identity's subject). Uniqueness the SQL schema enforced is checked by the
// mutations that write each table, using the indexes below. The scheduler tables carry the
// household-scoped indexes the per-household tick and the resync paths read (active tasks,
// instances by state, by task and state).
// Agent requests: a caregiver message to the household agent (agentRequests, the row the app
// subscribes to) and the tool calls the agent made for it (agentToolCalls, recorded once so a
// retried workflow step never repeats a calendar write).
// Google Calendar: calendarConnections (one per caregiver per household, refresh token stored
// encrypted), calendarEventLinks (our event to the Google event, per connection) and
// calendarSyncs (the pending push of one event to one connection; at most one row per key,
// see lib/calendarSync.ts).
// Delivery and the daily digest: notificationOutbox delivery bookkeeping and the digests
// table (one row per household and local date).
// Not yet ported (later phases): storage for photos and voice clips.
//
// Last modified: 2026-10-29

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  actorKind,
  calendarConnectionStatus,
  calendarSyncState,
  agentRequestStatus,
  confirmVia,
  deliveryChannel,
  deviceKind,
  digestSource,
  digestStatus,
  escalationAction,
  escalationStep,
  instanceState,
  joinGrant,
  lifeCategory,
  memberRole,
  memorySource,
  messageSender,
  notificationKind,
  questionOutcome,
  taskCreator,
  taskType,
  toolCall,
} from "./lib/validators";

export default defineSchema({
  households: defineTable({
    seniorPreferredName: v.string(),
    seniorFullName: v.optional(v.string()),
    // IANA region zone ("America/New_York"); validated by lib/time.isValidTimezone.
    timezone: v.string(),
    // Caregiver who gets the first alerts; must be a member of this household.
    onCallUserId: v.optional(v.string()),
    digestTime: v.string(),
    eventNoticeTime: v.string(),
    // Agreed at onboarding: caregivers see full transcripts only when true.
    shareTranscripts: v.boolean(),
    // Caregiver "stop": no background work for the household runs while true.
    backgroundPaused: v.boolean(),
  }),

  householdMembers: defineTable({
    householdId: v.id("households"),
    userId: v.string(),
    role: memberRole,
    displayName: v.string(),
    phone: v.optional(v.string()),
    // Set when the phone number was verified (part B, SMS). Added here only so delivery
    // compiles; the SMS work owns this field. A member is reachable by SMS only when both
    // phone and phoneVerifiedAt are set.
    phoneVerifiedAt: v.optional(v.number()),
  })
    .index("by_household_user", ["householdId", "userId"])
    .index("by_user", ["userId"]),

  // Senior-side devices; userId is the Clerk user created for the device at pairing.
  devices: defineTable({
    householdId: v.id("households"),
    userId: v.string(),
    kind: deviceKind,
    name: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
    // Set by /pair: when the device was paired and the client's retry nonce. Never returned
    // to clients (listDevices strips pairingNonce).
    pairedAt: v.optional(v.number()),
    pairingNonce: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_household", ["householdId"]),

  pushTokens: defineTable({
    userId: v.string(),
    token: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]),

  joinCodes: defineTable({
    code: v.string(),
    householdId: v.id("households"),
    grants: joinGrant,
    createdBy: v.optional(v.string()),
    expiresAt: v.number(),
    redeemedBy: v.optional(v.string()),
    redeemedAt: v.optional(v.number()),
  })
    .index("by_code", ["code"])
    .index("by_household", ["householdId"]),

  escalationPolicies: defineTable({
    householdId: v.id("households"),
    name: v.string(),
    // Stable key for the seeded defaults, so code never depends on the editable name.
    systemKey: v.optional(v.union(v.literal("medication"), v.literal("prompt_only"))),
    // Ordered; each step carries a stable id (instances record fired steps by id, so editing
    // the ladder never makes a step look fired or unfired).
    steps: v.array(escalationStep),
  })
    .index("by_household", ["householdId"])
    .index("by_household_system_key", ["householdId", "systemKey"]),

  tasks: defineTable({
    householdId: v.id("households"),
    type: taskType,
    // Caregiver-facing name, e.g. "Morning pills (lisinopril, metformin)".
    title: v.string(),
    // Short label the display and widget show, e.g. "Morning pills".
    displayLabel: v.string(),
    // Exact sentence every surface speaks or shows; defaults to "Time for <label>.".
    spokenPrompt: v.string(),
    pillDescription: v.optional(v.string()),
    checklistItems: v.array(v.string()),
    // Local "HH:MM" times. Empty = unscheduled (as-needed medication, only logged).
    times: v.array(v.string()),
    // ISO weekdays; absent = every day.
    daysOfWeek: v.optional(v.array(v.number())),
    // One-off task on a single local date.
    onceOn: v.optional(v.string()),
    startsOn: v.optional(v.string()),
    endsOn: v.optional(v.string()),
    windowMinutes: v.number(),
    escalationPolicyId: v.optional(v.id("escalationPolicies")),
    asNeededMaxPerDay: v.optional(v.number()),
    asNeededMinHours: v.optional(v.number()),
    createdByKind: taskCreator,
    createdBy: v.optional(v.string()),
    active: v.boolean(),
    // Last change to any schedule field; expansion never back-fills windows that opened
    // before the schedule existed.
    scheduleChangedAt: v.number(),
  })
    .index("by_household", ["householdId"])
    .index("by_household_active", ["householdId", "active"])
    .index("by_household_policy", ["householdId", "escalationPolicyId"]),

  taskInstances: defineTable({
    taskId: v.id("tasks"),
    householdId: v.id("households"),
    localDate: v.string(),
    scheduledTime: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
    state: instanceState,
    confirmedAt: v.optional(v.number()),
    confirmedBy: v.optional(v.string()),
    confirmedVia: v.optional(confirmVia),
    resolutionNote: v.optional(v.string()),
    snoozedUntil: v.optional(v.number()),
    claimedBy: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    // When the instance was created (escalation offsets count from the later of this and
    // windowStart). Explicit rather than _creationTime so tests can drive the clock.
    createdAt: v.number(),
    // Escalation steps already handled, each once, by the step's stable id. action is a
    // snapshot of the step as fired; notified is false for a step superseded by a later step of the same kind in
    // the same tick.
    firedSteps: v.array(
      v.object({
        stepId: v.string(),
        action: escalationAction,
        firedAt: v.number(),
        notified: v.boolean(),
      }),
    ),
  })
    .index("by_task_date_time", ["taskId", "localDate", "scheduledTime"])
    .index("by_household_date", ["householdId", "localDate"])
    // The scheduler tick reads one household's instances by state; resync deletes a task's
    // or household's upcoming instances without scanning history.
    .index("by_task_state", ["taskId", "state", "windowStart"])
    .index("by_household_state", ["householdId", "state", "windowStart"]),

  // As-needed medication taken outside a scheduled instance.
  doseLog: defineTable({
    householdId: v.id("households"),
    taskId: v.id("tasks"),
    takenAt: v.number(),
    reportedVia: confirmVia,
    reportedBy: v.optional(v.string()),
    note: v.optional(v.string()),
  }).index("by_household_task_taken", ["householdId", "taskId", "takenAt"]),

  // The only place notifications are queued; surfaces subscribe to their own rows and the
  // delivery action (delivery.ts) sends them by APNs (device recipients) or SMS (member
  // recipients). Exactly one recipient per row. Insert through lib/delivery.ts
  // insertNotification so the delivery job is enqueued. A row is settled once it is sent,
  // skipped (no reachable address) or failed for good; settledAt is absent until then.
  notificationOutbox: defineTable({
    householdId: v.id("households"),
    kind: notificationKind,
    taskInstanceId: v.optional(v.id("taskInstances")),
    eventId: v.optional(v.id("events")),
    recipientUserId: v.optional(v.string()),
    recipientDeviceId: v.optional(v.id("devices")),
    title: v.string(),
    body: v.string(),
    payload: v.record(v.string(), v.any()),
    sentAt: v.optional(v.number()),
    // Delivery bookkeeping. channel is the route taken ("none" when skipped); attempts counts
    // delivery runs; lastError is internal detail (never shown to clients); skippedReason says
    // why a row with no reachable address was finished without sending; failedAt is set when
    // delivery gave up.
    channel: v.optional(deliveryChannel),
    attempts: v.optional(v.number()),
    lastError: v.optional(v.string()),
    skippedReason: v.optional(v.string()),
    failedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
  })
    .index("by_recipient_user", ["recipientUserId"])
    .index("by_recipient_device", ["recipientDeviceId"])
    // Deleting an instance deletes its notifications (the SQL foreign key cascaded).
    .index("by_task_instance", ["taskInstanceId"])
    .index("by_household", ["householdId"])
    .index("by_sent", ["sentAt"])
    // The sweeper reads unsettled rows older than a cutoff (settledAt = undefined, then
    // creation time).
    .index("by_settled", ["settledAt"]),

  // One row per household per local date: the daily digest (digest.ts). status is pending
  // until the text is composed and its SMS rows are queued.
  digests: defineTable({
    householdId: v.id("households"),
    localDate: v.string(),
    status: digestStatus,
    // Which path produced the text, and the text itself (set when composed).
    source: v.optional(digestSource),
    text: v.optional(v.string()),
    // Outbox rows queued (verified phones at the time of sending).
    recipients: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_household_date", ["householdId", "localDate"])
    .index("by_status", ["status"]),

  // A caregiver's Google account connection; Sunny keeps its own secondary calendar there.
  calendarConnections: defineTable({
    householdId: v.id("households"),
    // Clerk user id of the caregiver who connected.
    userId: v.string(),
    provider: v.literal("google"),
    accountEmail: v.optional(v.string()),
    // The Sunny-owned calendar created in the caregiver's account.
    externalCalendarId: v.string(),
    status: calendarConnectionStatus,
    // Caregiver-readable reason when status is not active.
    error: v.optional(v.string()),
    // The OAuth refresh token as an encrypted box (lib/secretBox.ts). Never returned to clients.
    refreshToken: v.string(),
    // The current access token as an encrypted box and when it expires (epoch ms), so a
    // burst of pushes refreshes about once. Cleared on revoke and reconnect.
    accessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    // Caregiver-safe note that some pushes failed after retries; cleared by the next success.
    lastError: v.optional(v.string()),
  })
    .index("by_household_status", ["householdId", "status"])
    .index("by_household_user", ["householdId", "userId"]),

  // Our event to the Google event, per connection.
  calendarEventLinks: defineTable({
    eventId: v.id("events"),
    connectionId: v.id("calendarConnections"),
    externalEventId: v.string(),
    etag: v.optional(v.string()),
    syncedAt: v.number(),
  })
    .index("by_event_connection", ["eventId", "connectionId"])
    .index("by_connection", ["connectionId"]),

  // The pending push of one event to one connection; unique per (eventId, connectionId).
  // States and transitions: see lib/calendarSync.ts.
  calendarSyncs: defineTable({
    eventId: v.id("events"),
    connectionId: v.id("calendarConnections"),
    state: calendarSyncState,
    // Set on every transition; the sweeper re-enqueues rows idle for too long.
    updatedAt: v.number(),
    // Pushes that failed after all retries; one delayed re-enqueue is allowed.
    failures: v.optional(v.number()),
  })
    .index("by_event_connection", ["eventId", "connectionId"])
    .index("by_connection", ["connectionId"])
    .index("by_updated", ["updatedAt"]),

  // Single-use OAuth nonces: connectUrl stores one, the callback consumes it. Expired rows
  // are swept hourly (crons.ts).
  oauthStates: defineTable({
    nonce: v.string(),
    userId: v.string(),
    householdId: v.id("households"),
    expiresAt: v.number(),
  })
    .index("by_nonce", ["nonce"])
    .index("by_expires", ["expiresAt"]),

  auditLog: defineTable({
    householdId: v.id("households"),
    actorUserId: v.optional(v.string()),
    actorKind,
    action: v.string(),
    entity: v.string(),
    entityId: v.optional(v.string()),
    detail: v.record(v.string(), v.any()),
  }).index("by_household", ["householdId"]),

  // Appointments and visits, scheduled in household-local terms so 2 PM stays 2 PM across
  // DST; occurrences are computed (lib/occurrences.ts). Cancelling is a soft delete
  // (deletedAt) so the cancellation can sync to Google.
  events: defineTable({
    householdId: v.id("households"),
    title: v.string(),
    // Optional shorter or gentler wording the senior sees.
    label: v.optional(v.string()),
    startsOn: v.string(),
    startTime: v.string(),
    durationMinutes: v.optional(v.number()),
    place: v.optional(v.string()),
    visitorName: v.optional(v.string()),
    notes: v.optional(v.string()),
    // ISO weekdays of a weekly repeat; absent = one-off on startsOn.
    repeatDays: v.optional(v.array(v.number())),
    repeatUntil: v.optional(v.string()),
    createdVia: actorKind,
    createdBy: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_household", ["householdId"])
    // Live events: deletedAt is absent until cancelled.
    .index("by_household_deleted", ["householdId", "deletedAt"]),

  // Occurrences already announced to caregivers (one notice per event per local date).
  eventNotices: defineTable({
    eventId: v.id("events"),
    localDate: v.string(),
  }).index("by_event_date", ["eventId", "localDate"]),

  familyMessages: defineTable({
    householdId: v.id("households"),
    senderKind: messageSender,
    // Caregiver who sent it; absent when the senior sent it through the agent.
    senderUserId: v.optional(v.string()),
    body: v.optional(v.string()),
    photoStorageId: v.optional(v.id("_storage")),
    audioStorageId: v.optional(v.id("_storage")),
    seenAt: v.optional(v.number()),
  }).index("by_household", ["householdId"]),

  lifeProfileEntries: defineTable({
    householdId: v.id("households"),
    category: lifeCategory,
    name: v.string(),
    details: v.optional(v.string()),
    createdBy: v.optional(v.string()),
  }).index("by_household", ["householdId"]),

  // Caregiver-written guidance for hard questions, e.g. "Where's my husband?".
  sensitiveTopics: defineTable({
    householdId: v.id("households"),
    topic: v.string(),
    guidance: v.string(),
    createdBy: v.optional(v.string()),
  }).index("by_household", ["householdId"]),

  // Facts the agent knows. Verified once verifiedAt is set; senior-stated facts start
  // unverified and never overwrite caregiver-verified ones.
  agentMemory: defineTable({
    householdId: v.id("households"),
    fact: v.string(),
    source: memorySource,
    verifiedBy: v.optional(v.string()),
    verifiedAt: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
  }).index("by_household", ["householdId"]),

  conversations: defineTable({
    householdId: v.id("households"),
    deviceId: v.optional(v.id("devices")),
    // 'talk' (Talk button), 'scheduled_prompt', 'notification_tap'.
    trigger: v.string(),
    taskInstanceId: v.optional(v.id("taskInstances")),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    summary: v.optional(v.string()),
  }).index("by_household_started", ["householdId", "startedAt"]),

  conversationTurns: defineTable({
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
  }).index("by_conversation", ["conversationId"]),

  // One row per question the senior asked; the digest counts repeats by topic and day.
  agentQuestions: defineTable({
    householdId: v.id("households"),
    conversationId: v.optional(v.id("conversations")),
    askedAt: v.number(),
    question: v.string(),
    // Short normalized topic, e.g. "sarah visit time"; repeats share a topic.
    topic: v.string(),
    outcome: questionOutcome,
    toolsUsed: v.array(v.string()),
  }).index("by_household_asked", ["householdId", "askedAt"]),

  // A caregiver's request to the household agent. Run by the agentRuntime workflow.
  agentRequests: defineTable({
    householdId: v.id("households"),
    // Clerk user id of the requesting caregiver.
    requestedBy: v.string(),
    message: v.string(),
    // Earlier succeeded request whose Managed Agents session this one continues.
    continueRequestId: v.optional(v.id("agentRequests")),
    status: agentRequestStatus,
    workflowId: v.optional(v.string()),
    // Known up front for a continuation (copied from the earlier request), set after the
    // session starts otherwise. At most one in-progress request may use a session.
    sessionId: v.optional(v.string()),
    // user.message events the session had before this request's message was posted.
    baselineUserMessages: v.optional(v.number()),
    reply: v.optional(v.string()),
    // Caregiver-safe failure text; shown in the app.
    error: v.optional(v.string()),
    // Raw failure detail (SDK errors, env var names, ids). Never returned by agentRequests.
    errorDetail: v.optional(v.string()),
    finishedAt: v.optional(v.number()),
  })
    // Newest first (creation time is the implicit last index field).
    .index("by_household", ["householdId"])
    .index("by_household_status", ["householdId", "status"])
    .index("by_session", ["sessionId", "status"]),

  // One row per tool call the agent made for a request, with the result that was (or will be)
  // sent back. Written in the same transaction as the tool's effect.
  agentToolCalls: defineTable({
    requestId: v.id("agentRequests"),
    // toolUseId (Managed Agents event id of the agent.custom_tool_use), name and input.
    ...toolCall.fields,
    text: v.string(),
    isError: v.boolean(),
    sentAt: v.optional(v.number()),
  })
    .index("by_request_tool", ["requestId", "toolUseId"])
    // Calls whose result was sent: sentAt is absent until then, so gt(0) selects the sent ones.
    .index("by_request_sent", ["requestId", "sentAt"]),
});
