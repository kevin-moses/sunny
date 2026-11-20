import { vWorkIdValidator } from "@convex-dev/workpool";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  actorKind,
  calendarConnectionStatus,
  classifierRecord,
  mailboxStatus,
  mailEffectRecord,
  mailItemState,
  mailSender,
  verdictKind,
  jevAnswers,
  oauthPurpose,
  calendarSyncState,
  agentRequestStatus,
  confirmVia,
  deliveryChannel,
  deviceKind,
  deviceScreen,
  digestSource,
  digestStatus,
  escalationAction,
  instanceState,
  joinGrant,
  lifeCategory,
  listActorKind,
  memberRole,
  memorySource,
  messageSender,
  notificationKind,
  outboxState,
  questionOutcome,
  taskCreator,
  taskType,
  toolCall,
} from "./lib/validators";

export default defineSchema({
  households: defineTable({
    seniorPreferredName: v.string(),
    seniorFullName: v.optional(v.string()),
    timezone: v.string(),
    digestTime: v.string(),
    eventNoticeTime: v.string(),
    shareTranscripts: v.boolean(),
    backgroundPaused: v.boolean(),
    lastDigestDate: v.optional(v.string()),
    weatherLocation: v.optional(v.string()),
  }),

  householdMembers: defineTable({
    householdId: v.id("households"),
    userId: v.string(),
    role: memberRole,
    displayName: v.string(),
    phone: v.optional(v.string()),
    phoneVerifiedAt: v.optional(v.number()),
    pendingPhone: v.optional(v.string()),
  })
    .index("by_household_user", ["householdId", "userId"])
    .index("by_user", ["userId"])
    .index("by_phone", ["phone"]),

  phoneVerifications: defineTable({
    householdId: v.id("households"),
    userId: v.string(),
    phone: v.string(),
    codeHash: v.optional(v.string()),
    sendError: v.optional(v.string()),
    sendErrorDetail: v.optional(v.string()),
    expiresAt: v.number(),
    attempts: v.number(),
  })
    .index("by_household_user", ["householdId", "userId"])
    .index("by_expires", ["expiresAt"]),

  smsInbound: defineTable({
    messageSid: v.string(),
    reply: v.union(v.null(), v.string()),
    expiresAt: v.number(),
  })
    .index("by_sid", ["messageSid"])
    .index("by_expires", ["expiresAt"]),

  devices: defineTable({
    householdId: v.id("households"),
    userId: v.string(),
    kind: deviceKind,
    name: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
    pairedAt: v.optional(v.number()),
    pairingNonce: v.optional(v.string()),
    tokenHash: v.optional(v.string()),
    tokenIssuedAt: v.optional(v.number()),
    screen: v.optional(deviceScreen),
    firmware: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_household", ["householdId"])
    .index("by_token_hash", ["tokenHash"]),

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

  tasks: defineTable({
    householdId: v.id("households"),
    type: taskType,
    title: v.string(),
    displayLabel: v.string(),
    spokenPrompt: v.string(),
    pillDescription: v.optional(v.string()),
    checklistItems: v.array(v.string()),
    times: v.array(v.string()),
    daysOfWeek: v.optional(v.array(v.number())),
    onceOn: v.optional(v.string()),
    startsOn: v.optional(v.string()),
    endsOn: v.optional(v.string()),
    windowMinutes: v.number(),
    highPriority: v.boolean(),
    asNeededMaxPerDay: v.optional(v.number()),
    asNeededMinHours: v.optional(v.number()),
    createdByKind: taskCreator,
    createdBy: v.optional(v.string()),
    active: v.boolean(),
    scheduleChangedAt: v.number(),
  })
    .index("by_household", ["householdId"])
    .index("by_household_active", ["householdId", "active"]),

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
    confirmReceivedAt: v.optional(v.number()),
    resolvedFromState: v.optional(instanceState),
    resolvedFromSnoozedUntil: v.optional(v.number()),
    confirmTakenBackAt: v.optional(v.number()),
    confirmTakenBackBy: v.optional(v.string()),
    confirmPressIds: v.optional(v.array(v.string())),
    takenBackPressIds: v.optional(v.array(v.string())),
    currentStep: v.optional(v.number()),
    stepPresses: v.optional(
      v.array(
        v.object({
          step: v.number(),
          at: v.number(),
          by: v.optional(v.string()),
          pressId: v.optional(v.string()),
        }),
      ),
    ),
    resolutionNote: v.optional(v.string()),
    snoozedUntil: v.optional(v.number()),
    claimedBy: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
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
    .index("by_task_state", ["taskId", "state", "windowStart"])
    .index("by_household_state", ["householdId", "state", "windowStart"]),

  doseLog: defineTable({
    householdId: v.id("households"),
    taskId: v.id("tasks"),
    takenAt: v.number(),
    reportedVia: confirmVia,
    reportedBy: v.optional(v.string()),
    note: v.optional(v.string()),
    loggedAt: v.number(),
    conversationId: v.optional(v.id("conversations")),
    undoneAt: v.optional(v.number()),
  }).index("by_household_task_taken", ["householdId", "taskId", "takenAt"]),

  notificationOutbox: defineTable({
    householdId: v.id("households"),
    kind: notificationKind,
    taskInstanceId: v.optional(v.id("taskInstances")),
    eventId: v.optional(v.id("events")),
    seniorNoteId: v.optional(v.id("seniorNotes")),
    recipientUserId: v.optional(v.string()),
    recipientDeviceId: v.optional(v.id("devices")),
    title: v.string(),
    body: v.string(),
    payload: v.record(v.string(), v.any()),
    state: outboxState,
    channel: v.optional(deliveryChannel),
    settledAt: v.optional(v.number()),
    attempts: v.optional(v.number()),
    attemptStartedAt: v.optional(v.number()),
    detail: v.optional(v.string()),
    pushState: v.optional(v.union(v.literal("retrying"), v.literal("gave_up"))),
  })
    .index("by_recipient_kind", ["recipientUserId", "kind"])
    .index("by_recipient_device", ["recipientDeviceId"])
    .index("by_task_instance", ["taskInstanceId"])
    .index("by_household", ["householdId"])
    .index("by_state", ["state"]),

  digests: defineTable({
    householdId: v.id("households"),
    localDate: v.string(),
    status: digestStatus,
    source: v.optional(digestSource),
    text: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index("by_household_date", ["householdId", "localDate"])
    .index("by_status", ["status"]),

  chatPosts: defineTable(
    v.union(
      v.object({
        householdId: v.id("households"),
        kind: v.literal("digest"),
        body: v.string(),
        localDate: v.string(),
        digestId: v.id("digests"),
      }),
      v.object({
        householdId: v.id("households"),
        kind: v.literal("mail"),
        body: v.string(),
        localDate: v.string(),
        mailItemId: v.id("mailItems"),
      }),
      v.object({
        householdId: v.id("households"),
        kind: v.literal("mailbox"),
        body: v.string(),
        localDate: v.string(),
      }),
    ),
  ).index("by_household", ["householdId"]),

  calendarConnections: defineTable({
    householdId: v.id("households"),
    userId: v.string(),
    provider: v.literal("google"),
    accountEmail: v.optional(v.string()),
    externalCalendarId: v.string(),
    status: calendarConnectionStatus,
    error: v.optional(v.string()),
    refreshToken: v.string(),
    accessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_household_status", ["householdId", "status"])
    .index("by_household_user", ["householdId", "userId"])
    .index("by_account", ["accountEmail"]),

  calendarEventLinks: defineTable({
    eventId: v.id("events"),
    connectionId: v.id("calendarConnections"),
    externalEventId: v.string(),
    etag: v.optional(v.string()),
    syncedAt: v.number(),
  })
    .index("by_event_connection", ["eventId", "connectionId"])
    .index("by_connection", ["connectionId"]),

  calendarSyncs: defineTable({
    eventId: v.id("events"),
    connectionId: v.id("calendarConnections"),
    state: calendarSyncState,
    updatedAt: v.number(),
    failures: v.optional(v.number()),
  })
    .index("by_event_connection", ["eventId", "connectionId"])
    .index("by_connection", ["connectionId"])
    .index("by_updated", ["updatedAt"]),

  mailboxes: defineTable({
    householdId: v.id("households"),
    connectedBy: v.string(),
    accountEmail: v.string(),
    refreshToken: v.string(),
    accessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    status: mailboxStatus,
    error: v.optional(v.string()),
    historyId: v.string(),
    lastPolledAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    pollJobId: v.optional(vWorkIdValidator),
  })
    .index("by_household", ["householdId"])
    .index("by_status", ["status"])
    .index("by_account", ["accountEmail"]),

  mailItems: defineTable({
    householdId: v.id("households"),
    account: v.string(),
    gmailId: v.string(),
    state: mailItemState,
    attempt: v.number(),
    heldClaims: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
    jobId: v.optional(vWorkIdValidator),
    sender: v.optional(mailSender),
    subject: v.optional(v.string()),
    receivedAt: v.optional(v.number()),
    verdict: v.optional(verdictKind),
    rule: v.optional(v.string()),
    judgeRule: v.optional(v.string()),
    judgeAnswers: v.optional(jevAnswers),
    effects: v.optional(v.array(mailEffectRecord)),
    escalatedAt: v.optional(v.number()),
    calendarChangedAt: v.optional(v.number()),
    classifier: v.optional(classifierRecord),
    caregiverPost: v.optional(v.object({ postId: v.id("chatPosts"), line: v.string() })),
  })
    .index("by_household_account_gmail", ["householdId", "account", "gmailId"])
    .index("by_state_lease", ["state", "leaseUntil"])
    .index("by_household_received", ["householdId", "receivedAt"])
    .index("by_household_escalated", ["householdId", "escalatedAt"])
    .index("by_household_calendar_changed", ["householdId", "calendarChangedAt"]),

  seniorNotes: defineTable({
    householdId: v.id("households"),
    mailItemId: v.id("mailItems"),
    text: v.string(),
    receivedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_household_received", ["householdId", "receivedAt"])
    .index("by_household", ["householdId"]),

  mailEventLinks: defineTable({
    householdId: v.id("households"),
    eventId: v.id("events"),
    appointmentKey: v.string(),
    senderDomain: v.string(),
    mailItemId: v.id("mailItems"),
    sequence: v.optional(v.number()),
  }).index("by_household_domain_key", ["householdId", "senderDomain", "appointmentKey"]),

  oauthFlows: defineTable({
    ticketHash: v.string(),
    userId: v.string(),
    householdId: v.id("households"),
    purpose: oauthPurpose,
    expiresAt: v.number(),
    started: v.optional(v.object({ browserHash: v.string(), codeVerifier: v.string() })),
    consumedAt: v.optional(v.number()),
  })
    .index("by_ticket", ["ticketHash"])
    .index("by_expires", ["expiresAt"]),

  auditLog: defineTable({
    householdId: v.id("households"),
    actorUserId: v.optional(v.string()),
    actorKind,
    action: v.string(),
    entity: v.string(),
    entityId: v.optional(v.string()),
    detail: v.record(v.string(), v.any()),
  })
    .index("by_household", ["householdId"])
    .index("by_household_action", ["householdId", "action"]),

  agentFlags: defineTable({
    householdId: v.id("households"),
    reason: v.string(),
    key: v.string(),
    at: v.number(),
    names: v.array(v.string()),
    recipientUserIds: v.array(v.string()),
    doseId: v.optional(v.id("doseLog")),
    conversationId: v.optional(v.id("conversations")),
  })
    .index("by_household_key_at", ["householdId", "key", "at"])
    .index("by_household_at", ["householdId", "at"]),

  events: defineTable({
    householdId: v.id("households"),
    title: v.string(),
    label: v.optional(v.string()),
    startsOn: v.string(),
    startTime: v.string(),
    durationMinutes: v.optional(v.number()),
    place: v.optional(v.string()),
    visitorName: v.optional(v.string()),
    notes: v.optional(v.string()),
    repeatDays: v.optional(v.array(v.number())),
    repeatUntil: v.optional(v.string()),
    createdVia: actorKind,
    createdBy: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_household", ["householdId"])
    .index("by_household_deleted", ["householdId", "deletedAt"]),

  eventNotices: defineTable({
    eventId: v.id("events"),
    localDate: v.string(),
  }).index("by_event_date", ["eventId", "localDate"]),

  familyMessages: defineTable({
    householdId: v.id("households"),
    senderKind: messageSender,
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

  sensitiveTopics: defineTable({
    householdId: v.id("households"),
    topic: v.string(),
    guidance: v.string(),
    createdBy: v.optional(v.string()),
  }).index("by_household", ["householdId"]),

  agentMemory: defineTable({
    householdId: v.id("households"),
    fact: v.string(),
    source: memorySource,
    verifiedBy: v.optional(v.string()),
    verifiedAt: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
  })
    .index("by_household", ["householdId"])
    .index("by_household_verified", ["householdId", "verifiedAt"]),

  conversations: defineTable({
    householdId: v.id("households"),
    deviceId: v.optional(v.id("devices")),
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

  listItems: defineTable({
    householdId: v.id("households"),
    text: v.string(),
    addedByKind: listActorKind,
    addedBy: v.optional(v.string()),
    addedAt: v.number(),
    doneAt: v.optional(v.number()),
    doneByKind: v.optional(listActorKind),
    doneBy: v.optional(v.string()),
  })
    .index("by_household_done", ["householdId", "doneAt"])
    .index("by_household_added", ["householdId", "addedAt"]),

  agentQuestions: defineTable({
    householdId: v.id("households"),
    conversationId: v.optional(v.id("conversations")),
    askedAt: v.number(),
    question: v.string(),
    topic: v.string(),
    outcome: questionOutcome,
    toolsUsed: v.array(v.string()),
  }).index("by_household_asked", ["householdId", "askedAt"]),

  agentRequests: defineTable({
    householdId: v.id("households"),
    requestedBy: v.string(),
    message: v.string(),
    continueRequestId: v.optional(v.id("agentRequests")),
    status: agentRequestStatus,
    workflowId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    agentConfig: v.string(),
    carryOver: v.optional(v.boolean()),
    baselineUserMessages: v.optional(v.number()),
    reply: v.optional(v.string()),
    error: v.optional(v.string()),
    errorDetail: v.optional(v.string()),
    finishedAt: v.optional(v.number()),
    changedTaskIds: v.optional(v.array(v.id("tasks"))),
  })
    .index("by_household", ["householdId"])
    .index("by_household_status", ["householdId", "status"])
    .index("by_session", ["sessionId", "status"]),

  agentToolCalls: defineTable({
    requestId: v.id("agentRequests"),
    ...toolCall.fields,
    text: v.string(),
    isError: v.boolean(),
    sentAt: v.optional(v.number()),
  })
    .index("by_request_tool", ["requestId", "toolUseId"])
    .index("by_request_sent", ["requestId", "sentAt"]),
});
