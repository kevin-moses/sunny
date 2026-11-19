import { v, type Infer } from "convex/values";
import { DECISION_REASONS, INFO_TOPICS, SUSPICIONS } from "./mailTypes";

export const memberRole = v.union(v.literal("primary"), v.literal("member"), v.literal("viewer"));
export type MemberRole = Infer<typeof memberRole>;

export const deviceKind = v.union(v.literal("senior_phone"), v.literal("home_display"));
export type DeviceKind = Infer<typeof deviceKind>;

export const deviceScreen = v.object({ width: v.number(), height: v.number(), greys: v.number() });
export type DeviceScreen = Infer<typeof deviceScreen>;

export const DEVICE_VIAS = ["button", "widget", "live_activity", "phone_app"] as const;
export const deviceVia = v.union(...DEVICE_VIAS.map((via) => v.literal(via)));
export type DeviceVia = Infer<typeof deviceVia>;

export const joinGrant = v.union(
  v.literal("senior_phone"),
  v.literal("home_display"),
  v.literal("caregiver_primary"),
  v.literal("caregiver_member"),
  v.literal("caregiver_viewer"),
);
export type JoinGrant = Infer<typeof joinGrant>;

export const taskType = v.union(
  v.literal("medication"),
  v.literal("appointment"),
  v.literal("routine"),
  v.literal("checklist"),
  v.literal("reminder"),
);
export type TaskType = Infer<typeof taskType>;

export const taskCreator = v.union(v.literal("caregiver"), v.literal("senior"));

export const instanceState = v.union(
  v.literal("upcoming"),
  v.literal("due"),
  v.literal("escalated"),
  v.literal("confirmed"),
  v.literal("missed"),
  v.literal("resolved"),
);
export type InstanceState = Infer<typeof instanceState>;

export const confirmVia = v.union(
  v.literal("button"),
  v.literal("widget"),
  v.literal("live_activity"),
  v.literal("phone_app"),
  v.literal("voice"),
  v.literal("caregiver"),
);
export type ConfirmVia = Infer<typeof confirmVia>;

export const escalationAction = v.union(
  v.literal("prompt_senior"),
  v.literal("alert_all_caregivers"),
);
export type EscalationAction = Infer<typeof escalationAction>;

export const actorKind = v.union(
  v.literal("caregiver"),
  v.literal("senior_device"),
  v.literal("agent"),
  v.literal("system"),
);
export type ActorKind = Infer<typeof actorKind>;

export const notificationKind = v.union(
  v.literal("senior_prompt"),
  v.literal("caregiver_alert"),
  v.literal("event_notice"),
  v.literal("digest"),
  v.literal("agent_flag"),
  v.literal("family_message"),
  v.literal("senior_note"),
  v.literal("mail_escalation"),
  v.literal("mail_update"),
);
export type NotificationKind = Infer<typeof notificationKind>;

export const outboxState = v.union(
  v.literal("pending"),
  v.literal("sent"),
  v.literal("skipped"),
  v.literal("failed"),
);
export type OutboxState = Infer<typeof outboxState>;

export const deliveryChannel = v.union(v.literal("apns"), v.literal("sms"));
export type DeliveryChannel = Infer<typeof deliveryChannel>;

export const digestStatus = v.union(v.literal("pending"), v.literal("done"), v.literal("failed"));
export type DigestStatus = Infer<typeof digestStatus>;

export const digestSource = v.union(v.literal("claude"), v.literal("template"));
export type DigestSource = Infer<typeof digestSource>;

export const messageSender = v.union(v.literal("caregiver"), v.literal("senior"));

export const lifeCategory = v.union(
  v.literal("person"),
  v.literal("place"),
  v.literal("doctor"),
  v.literal("habit"),
  v.literal("interest"),
  v.literal("preference"),
  v.literal("other"),
);

export const LIFE_CATEGORIES: readonly string[] = lifeCategory.members.map((m) => m.value);

export const memorySource = v.union(v.literal("caregiver"), v.literal("senior"));

export const questionOutcome = v.union(
  v.literal("answered"),
  v.literal("routed"),
  v.literal("unsure"),
);
export type QuestionOutcome = Infer<typeof questionOutcome>;

export const listActorKind = v.union(v.literal("senior"), v.literal("caregiver"));
export type ListActorKind = Infer<typeof listActorKind>;

export const agentRequestStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);
export type AgentRequestStatus = Infer<typeof agentRequestStatus>;

export const toolCall = v.object({
  toolUseId: v.string(),
  name: v.string(),
  input: v.string(),
});
export type ToolCall = Infer<typeof toolCall>;

export const calendarConnectionStatus = v.union(
  v.literal("active"),
  v.literal("revoked"),
  v.literal("error"),
);
export type CalendarConnectionStatus = Infer<typeof calendarConnectionStatus>;

export const oauthPurpose = v.union(v.literal("calendar"), v.literal("mailbox"));
export type OAuthPurpose = Infer<typeof oauthPurpose>;

export const mailboxStatus = v.union(v.literal("active"), v.literal("revoked"), v.literal("error"));
export type MailboxStatus = Infer<typeof mailboxStatus>;

export const mailItemState = v.union(
  v.literal("queued"),
  v.literal("triaging"),
  v.literal("done"),
  v.literal("failed"),
);
export type MailItemState = Infer<typeof mailItemState>;

const literals = <T extends string>(values: readonly T[]) =>
  v.union(...values.map((value) => v.literal(value)));

const appointment = v.object({
  title: v.string(),
  date: v.string(),
  time: v.string(),
  durationMinutes: v.union(v.null(), v.number()),
  place: v.union(v.null(), v.string()),
});

const appointmentRef = v.object({
  date: v.string(),
  time: v.union(v.null(), v.string()),
  title: v.string(),
});

export const mailVerdict = v.union(
  v.object({ kind: v.literal("ignore"), summary: v.string() }),
  v.object({
    kind: v.literal("appointment"),
    change: v.literal("new"),
    appointment,
    summary: v.string(),
  }),
  v.object({
    kind: v.literal("appointment"),
    change: v.literal("reschedule"),
    previous: appointmentRef,
    appointment,
    summary: v.string(),
  }),
  v.object({
    kind: v.literal("appointment"),
    change: v.literal("cancel"),
    previous: appointmentRef,
    summary: v.string(),
  }),
  v.object({
    kind: v.literal("senior_info"),
    topic: literals(INFO_TOPICS),
    note: v.string(),
    summary: v.string(),
  }),
  v.object({
    kind: v.literal("needs_decision"),
    reason: literals(DECISION_REASONS),
    summary: v.string(),
  }),
  v.object({
    kind: v.literal("suspicious"),
    suspicion: literals(SUSPICIONS),
    summary: v.string(),
  }),
);

const usage = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  cacheReadTokens: v.number(),
});

export const triaged = v.union(
  v.object({ stage: v.literal("gate"), verdict: mailVerdict, rule: v.string() }),
  v.object({
    stage: v.literal("model"),
    verdict: v.union(v.null(), mailVerdict),
    usage,
    classifier: v.string(),
  }),
);

export const icsEvent = v.object({
  method: literals(["REQUEST", "CANCEL", "REPLY", "OTHER"] as const),
  uid: v.string(),
  start: v.union(v.null(), v.object({ date: v.string(), time: v.string() })),
  durationMinutes: v.union(v.null(), v.number()),
  summary: v.string(),
  location: v.union(v.null(), v.string()),
  recurring: v.boolean(),
  sequence: v.number(),
});

export const mailSender = v.object({
  name: v.string(),
  address: v.string(),
  authenticated: v.boolean(),
  known: v.boolean(),
});
export type StoredSender = Infer<typeof mailSender>;

export const storedVerdict = v.object({
  kind: literals([
    "ignore",
    "appointment",
    "senior_info",
    "needs_decision",
    "suspicious",
    "unreadable",
  ] as const),
  summary: v.string(),
});
export type StoredVerdict = Infer<typeof storedVerdict>;

export const mailEffectRecord = v.union(
  v.object({ kind: v.literal("event_added"), eventId: v.id("events") }),
  v.object({
    kind: v.literal("event_rescheduled"),
    eventId: v.id("events"),
    fromDate: v.string(),
    fromTime: v.string(),
  }),
  v.object({ kind: v.literal("already_on_calendar"), eventId: v.id("events") }),
  v.object({ kind: v.literal("senior_note"), noteId: v.id("seniorNotes") }),
  v.object({ kind: v.literal("told_caregivers"), pushed: v.boolean() }),
  v.object({
    kind: v.literal("escalated"),
    reason: literals([
      ...DECISION_REASONS,
      ...SUSPICIONS,
      "unverified_sender",
      "unclear_appointment",
      "unclear_reschedule",
      "conflict",
      "unreadable",
    ] as const),
    pushed: v.boolean(),
    eventId: v.optional(v.id("events")),
    proposed: v.optional(v.object({ date: v.string(), time: v.string() })),
  }),
);
export type MailEffectRecord = Infer<typeof mailEffectRecord>;

export const classifierRecord = v.object({ name: v.string(), usage });
export type ClassifierRecord = Infer<typeof classifierRecord>;

export const calendarSyncState = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("dirty"),
);
