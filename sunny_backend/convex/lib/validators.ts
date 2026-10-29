// lib/validators.ts
// Purpose: Shared value validators (enums and formatted strings) used by the schema and
// by function arguments, so a type such as a task state or a local date has one
// definition. Mirrors the Postgres enums from the Supabase schema.
//
// Last modified: 2026-10-28

import { v, type Infer } from "convex/values";

/** Role of a caregiver in a household. */
export const memberRole = v.union(v.literal("primary"), v.literal("member"), v.literal("viewer"));
/** Type of memberRole. */
export type MemberRole = Infer<typeof memberRole>;

/** Kind of paired senior device. */
export const deviceKind = v.union(v.literal("senior_phone"), v.literal("home_display"));
/** Type of deviceKind. */
export type DeviceKind = Infer<typeof deviceKind>;

/** What a join code grants: a device kind or a caregiver role. */
export const joinGrant = v.union(
  v.literal("senior_phone"),
  v.literal("home_display"),
  v.literal("caregiver_primary"),
  v.literal("caregiver_member"),
  v.literal("caregiver_viewer"),
);
/** Type of joinGrant. */
export type JoinGrant = Infer<typeof joinGrant>;

/** Kind of task a caregiver can schedule. */
export const taskType = v.union(
  v.literal("medication"),
  v.literal("appointment"),
  v.literal("routine"),
  v.literal("checklist"),
  v.literal("reminder"),
);
/** Type of taskType. */
export type TaskType = Infer<typeof taskType>;

/** Who created a task. */
export const taskCreator = v.union(v.literal("caregiver"), v.literal("senior"));

/** Lifecycle state of a task instance. */
export const instanceState = v.union(
  v.literal("upcoming"),
  v.literal("due"),
  v.literal("escalated"),
  v.literal("confirmed"),
  v.literal("missed"),
  v.literal("resolved"),
);
/** Type of instanceState. */
export type InstanceState = Infer<typeof instanceState>;

/** How a task instance was confirmed. */
export const confirmVia = v.union(
  v.literal("button"),
  v.literal("widget"),
  v.literal("live_activity"),
  v.literal("phone_app"),
  v.literal("voice"),
  v.literal("caregiver"),
);
/** Type of confirmVia. */
export type ConfirmVia = Infer<typeof confirmVia>;

/** What an escalation step does. */
export const escalationAction = v.union(
  v.literal("prompt_senior"),
  v.literal("alert_on_call"),
  v.literal("alert_all_caregivers"),
);
/** Type of escalationAction. */
export type EscalationAction = Infer<typeof escalationAction>;

/** One step of an escalation policy, at an offset from the due time. */
export const escalationStep = v.object({
  offsetMinutes: v.number(),
  action: escalationAction,
  // When true the step is skipped once a caregiver has claimed the instance.
  skipIfClaimed: v.boolean(),
});
/** Type of escalationStep. */
export type EscalationStep = Infer<typeof escalationStep>;

/** Who performed a change, for audit rows. */
export const actorKind = v.union(
  v.literal("caregiver"),
  v.literal("senior_device"),
  v.literal("agent"),
  v.literal("system"),
);
/** Type of actorKind. */
export type ActorKind = Infer<typeof actorKind>;

/** Purpose of a notification. */
export const notificationKind = v.union(
  v.literal("senior_prompt"),
  v.literal("caregiver_alert"),
  v.literal("event_notice"),
);
/** Type of notificationKind. */
export type NotificationKind = Infer<typeof notificationKind>;

/** Who sent a message. */
export const messageSender = v.union(v.literal("caregiver"), v.literal("senior"));

/** Category of a life-story memory. */
export const lifeCategory = v.union(
  v.literal("person"),
  v.literal("place"),
  v.literal("doctor"),
  v.literal("habit"),
  v.literal("interest"),
  v.literal("preference"),
  v.literal("other"),
);

/** Who contributed a life-story memory. */
export const memorySource = v.union(v.literal("caregiver"), v.literal("senior"));

/** How the agent resolved a senior's question. */
export const questionOutcome = v.union(
  v.literal("answered"),
  v.literal("routed"),
  v.literal("unsure"),
);
