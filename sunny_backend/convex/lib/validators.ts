// lib/validators.ts
// Purpose: Shared value validators (enums and formatted strings) used by the schema and
// by function arguments, so a type such as a task state or a local date has one
// definition. Mirrors the Postgres enums from the Supabase schema.
//
// Last modified: 2026-10-29

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

/** The fields of an escalation step other than its id. */
const escalationStepFields = {
  offsetMinutes: v.number(),
  action: escalationAction,
  // When true the step is skipped once a caregiver has claimed the instance.
  skipIfClaimed: v.boolean(),
};

/**
 * One stored step of an escalation policy, at an offset from the due time. The id is assigned
 * by the server and stays with the step when a policy is edited, so a step already fired on an
 * instance is recognised even when steps before it are added, removed or reordered.
 */
export const escalationStep = v.object({ id: v.string(), ...escalationStepFields });
/** Type of escalationStep. */
export type EscalationStep = Infer<typeof escalationStep>;

/**
 * A step as a client sends it. An id is optional: a step passed back with the id it was read
 * with keeps it (updatePolicy); a step without one, or with an id the policy does not have,
 * gets a new id.
 */
export const escalationStepInput = v.object({
  id: v.optional(v.string()),
  ...escalationStepFields,
});
/** Type of escalationStepInput. */
export type EscalationStepInput = Infer<typeof escalationStepInput>;

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
  v.literal("digest"),
);
/** Type of notificationKind. */
export type NotificationKind = Infer<typeof notificationKind>;

/** How an outbox row was (or was not) delivered: APNs push, SMS, or no reachable address. */
export const deliveryChannel = v.union(v.literal("apns"), v.literal("sms"), v.literal("none"));
/** Type of deliveryChannel. */
export type DeliveryChannel = Infer<typeof deliveryChannel>;

/** Where a household's daily digest for one local date stands (see digest.ts). */
export const digestStatus = v.union(
  v.literal("pending"),
  v.literal("sent"),
  v.literal("no_recipients"),
  v.literal("failed"),
);
/** Type of digestStatus. */
export type DigestStatus = Infer<typeof digestStatus>;

/** Which path produced a digest's text: the model, or the deterministic template. */
export const digestSource = v.union(v.literal("claude"), v.literal("template"));
/** Type of digestSource. */
export type DigestSource = Infer<typeof digestSource>;

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

/** Where a caregiver's request to the household agent stands. */
export const agentRequestStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);
/** Type of agentRequestStatus. */
export type AgentRequestStatus = Infer<typeof agentRequestStatus>;

/**
 * One custom tool call the agent made: the Managed Agents event id, tool name and input. The
 * input is JSON text, not a Convex object, so model-chosen keys can never fail validation.
 */
export const toolCall = v.object({
  toolUseId: v.string(),
  name: v.string(),
  input: v.string(),
});
/** Type of toolCall. */
export type ToolCall = Infer<typeof toolCall>;

/** Health of a caregiver's Google Calendar connection. */
export const calendarConnectionStatus = v.union(
  v.literal("active"),
  v.literal("revoked"),
  v.literal("error"),
);
/** Type of calendarConnectionStatus. */
export type CalendarConnectionStatus = Infer<typeof calendarConnectionStatus>;

/** Where a pending Google push is (see lib/calendarSync.ts for the transitions). */
export const calendarSyncState = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("dirty"),
);
