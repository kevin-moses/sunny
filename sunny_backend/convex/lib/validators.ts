import { v, type Infer } from "convex/values";

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
  v.literal("senior_reshow"),
);
export type NotificationKind = Infer<typeof notificationKind>;

export const outboxState = v.union(
  v.literal("pending"),
  v.literal("sent"),
  v.literal("skipped"),
  v.literal("failed"),
);
export type OutboxState = Infer<typeof outboxState>;

export const deliveryChannel = v.union(
  v.literal("apns"),
  v.literal("sms"),
  v.literal("live_activity"),
);
export type DeliveryChannel = Infer<typeof deliveryChannel>;

export const PUSH_TYPES = ["alert", "liveactivity", "background", "widgets"] as const;
export const pushType = v.union(...PUSH_TYPES.map((type) => v.literal(type)));
export type PushType = Infer<typeof pushType>;

export const apnsMessage = v.object({
  pushType,
  priority: v.union(v.literal(5), v.literal(10)),
  expiresAt: v.number(),
  collapseId: v.optional(v.string()),
  body: v.string(),
});
export type ApnsMessage = Infer<typeof apnsMessage>;

export const DEVICE_ICONS = ["pills", "calendar", "checklist", "bell", "clock"] as const;
export const deviceIcon = v.union(...DEVICE_ICONS.map((icon) => v.literal(icon)));
export type DeviceIcon = Infer<typeof deviceIcon>;

export const activityCard = v.object({
  instanceId: v.id("taskInstances"),
  step: v.number(),
  stepCount: v.number(),
  stepText: v.union(v.string(), v.null()),
  label: v.string(),
  sentence: v.union(v.string(), v.null()),
  detail: v.union(v.string(), v.null()),
  icon: deviceIcon,
  startsAt: v.number(),
  endsAt: v.number(),
});

export const activityClosed = v.object({
  kind: v.union(v.literal("done"), v.literal("over")),
  at: v.number(),
});
export type ActivityClosed = Infer<typeof activityClosed>;

export const activityContent = v.object({
  card: activityCard,
  nextSteps: v.array(v.string()),
  closed: v.union(activityClosed, v.null()),
});
export type ActivityContent = Infer<typeof activityContent>;

export const activityEndReason = v.union(
  v.literal("confirmed"),
  v.literal("window_closed"),
  v.literal("instance_gone"),
  v.literal("start_failed"),
  v.literal("ended_on_phone"),
  v.literal("expired"),
  v.literal("device_revoked"),
);
export type ActivityEndReason = Infer<typeof activityEndReason>;

export const startProof = v.union(v.literal("awaited"), v.literal("proven"), v.literal("missed"));

export const liveActivityPhase = v.union(
  v.object({
    kind: v.literal("starting"),
    outboxId: v.id("notificationOutbox"),
    since: v.number(),
  }),
  v.object({ kind: v.literal("started"), acceptedAt: v.number(), proof: startProof }),
  v.object({
    kind: v.literal("live"),
    acceptedAt: v.number(),
    updateToken: v.string(),
  }),
  v.object({ kind: v.literal("ended"), at: v.number(), reason: activityEndReason }),
);
export type LiveActivityPhase = Infer<typeof liveActivityPhase>;

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

export const calendarSyncState = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("dirty"),
);

export const REPORTED_ACTIVITY_STATES = ["active", "stale", "ended", "dismissed"] as const;
export const reportedActivityState = v.union(
  ...REPORTED_ACTIVITY_STATES.map((state) => v.literal(state)),
);
export type ReportedActivityState = Infer<typeof reportedActivityState>;

export const reportedActivity = v.object({
  key: v.string(),
  token: v.union(v.string(), v.null()),
  state: reportedActivityState,
});
export type ReportedActivity = Infer<typeof reportedActivity>;

export const pushStateReport = v.object({
  liveActivityStart: v.optional(
    v.object({ token: v.union(v.string(), v.null()), enabled: v.boolean() }),
  ),
  activities: v.optional(v.array(reportedActivity)),
  widgetPush: v.optional(v.object({ token: v.union(v.string(), v.null()) })),
});
export type PushStateReport = Infer<typeof pushStateReport>;

export const reportedPushToken = v.object({ token: v.string() });
