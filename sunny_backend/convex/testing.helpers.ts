// testing.helpers.ts
// Purpose: Shared helpers for the backend tests (agentRequests, agentRuntime, agentTools,
// eventNotices, the calendar sync tests): the convex-test harness with every backend module and
// the workflow and workpool components registered, creating a household through the real
// households.create (alone, or with a full family and a paired device), inserting agent
// request and event rows, and the Google Calendar fixtures (connections, members, events added
// through the public API, a household that has all of them, and the pending sync rows).
// The name has two dots, so Convex does not treat this file as a function module.
//
// Last modified: 2026-10-29

import workpoolTest from "@convex-dev/workpool/test";
import workflowTest from "@convex-dev/workflow/test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import type { AgentRequestStatus } from "./lib/validators";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.helpers.ts"]);

/**
 * purpose: A fresh in-memory backend with the workflow component registered.
 * @return: The convex-test harness typed with the schema.
 */
export function makeBackend() {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  workpoolTest.register(t, "calendarSyncPool");
  workpoolTest.register(t, "deliveryPool");
  return t;
}

/** The convex-test harness type, with the schema's table types. */
export type TestConvex = ReturnType<typeof makeBackend>;

/**
 * purpose: Create a household through the real households.create.
 * @param t: (TestConvex) Harness.
 * @param options: ({ subject, seniorName, caregiverName, timezone }) Who creates it and its
 *        details; defaults to user_a, Margaret, Anna and America/New_York.
 * @return: (Promise<Id<"households">>) The household.
 */
export async function createHousehold(
  t: TestConvex,
  options: {
    subject?: string;
    seniorName?: string;
    caregiverName?: string;
    timezone?: string;
  } = {},
): Promise<Id<"households">> {
  return await t
    .withIdentity({ subject: options.subject ?? "user_a" })
    .mutation(api.households.create, {
      seniorPreferredName: options.seniorName ?? "Margaret",
      timezone: options.timezone ?? "America/New_York",
      caregiverDisplayName: options.caregiverName ?? "Anna",
    });
}

/**
 * purpose: Insert an agent request row directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param fields: (object) Overrides for status, sessionId, reply, error and finishedAt.
 * @return: (Promise<Id<"agentRequests">>) The request.
 */
export async function insertRequest(
  t: TestConvex,
  householdId: Id<"households">,
  fields: Partial<{
    status: AgentRequestStatus;
    sessionId: string;
    reply: string;
    error: string;
    finishedAt: number;
  }> = {},
): Promise<Id<"agentRequests">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("agentRequests", {
      householdId,
      requestedBy: "user_a",
      message: "hello",
      status: "queued",
      ...fields,
    });
  });
}

/**
 * purpose: Create a household with Pat (primary), Max (member), Val (viewer) and one paired
 *          device ("phone"), through the real mutations.
 * @param t: (TestConvex) Harness.
 * @param timezone: (string) IANA zone of the household.
 * @return: (Promise<Id<"households">>) The household.
 */
export async function createFamilyHousehold(
  t: TestConvex,
  timezone = "America/New_York",
): Promise<Id<"households">> {
  const pat = t.withIdentity({ subject: "pat" });
  const householdId = await pat.mutation(api.households.create, {
    seniorPreferredName: "Mom",
    timezone,
    caregiverDisplayName: "Pat",
  });
  for (const [user, grants] of [
    ["max", "caregiver_member"],
    ["val", "caregiver_viewer"],
  ] as const) {
    const { code } = await pat.mutation(api.households.createJoinCode, { householdId, grants });
    await t.withIdentity({ subject: user }).mutation(api.households.redeemJoinCode, { code });
  }
  const { code } = await pat.mutation(api.households.createJoinCode, {
    householdId,
    grants: "senior_phone",
  });
  await t.mutation(internal.households.pairDevice, { code, userId: "phone" });
  return householdId;
}

/**
 * purpose: Insert an event row directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param fields: (object) Event fields; title, startsOn and startTime are required.
 * @return: (Promise<Id<"events">>) The event.
 */
export async function insertEvent(
  t: TestConvex,
  householdId: Id<"households">,
  fields: Partial<Doc<"events">> & { title: string; startsOn: string; startTime: string },
): Promise<Id<"events">> {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("events", { householdId, createdVia: "caregiver", ...fields }),
  );
}

/** A date far enough ahead that events on it are never in the past. */
const FAR_FUTURE = "2099-06-01";

/**
 * purpose: Insert a Google connection directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param fields: (object) Overrides for userId, status and calendar id.
 * @return: (Promise<Id<"calendarConnections">>) The connection.
 */
export async function addConnection(
  t: TestConvex,
  householdId: Id<"households">,
  fields: { userId?: string; status?: "active" | "revoked" | "error"; calendarId?: string } = {},
): Promise<Id<"calendarConnections">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("calendarConnections", {
      householdId,
      userId: fields.userId ?? "user_a",
      provider: "google",
      accountEmail: "anna@example.com",
      externalCalendarId: fields.calendarId ?? "cal1",
      status: fields.status ?? "active",
      refreshToken: "box:refresh-1",
    });
  });
}

/**
 * purpose: Add a caregiver member row directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) User id.
 * @return: (Promise<void>) Resolves when inserted.
 */
export async function addMember(
  t: TestConvex,
  householdId: Id<"households">,
  userId: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("householdMembers", {
      householdId,
      userId,
      role: "member",
      displayName: userId,
    });
  });
}

/**
 * purpose: Add an event through the public mutation as user_a (so it queues Google pushes).
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param title: (string) Title.
 * @return: (Promise<Id<"events">>) The event id.
 */
export async function addCalendarEvent(
  t: TestConvex,
  householdId: Id<"households">,
  title = "Dentist",
): Promise<Id<"events">> {
  const event = await t.withIdentity({ subject: "user_a" }).mutation(api.calendar.addEvent, {
    householdId,
    title,
    onDate: FAR_FUTURE,
    startTime: "10:00",
  });
  return event.eventId;
}

/**
 * purpose: A household with user_a as primary, one active connection and one event.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<object>) The household, connection and event ids.
 */
export async function setupSynced(t: TestConvex): Promise<{
  householdId: Id<"households">;
  connectionId: Id<"calendarConnections">;
  eventId: Id<"events">;
}> {
  const householdId = await createHousehold(t);
  const connectionId = await addConnection(t, householdId);
  const eventId = await addCalendarEvent(t, householdId);
  return { householdId, connectionId, eventId };
}

/**
 * purpose: All calendarSyncs rows.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<Doc<"calendarSyncs">[]>) The rows.
 */
export async function syncRows(t: TestConvex): Promise<Doc<"calendarSyncs">[]> {
  return await t.run(async (ctx) => await ctx.db.query("calendarSyncs").collect());
}

/**
 * purpose: Delete every calendarSyncs row (to observe what a later change queues).
 * @param t: (TestConvex) Harness.
 * @return: (Promise<void>) Resolves when deleted.
 */
export async function clearSyncs(t: TestConvex): Promise<void> {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("calendarSyncs").collect()) await ctx.db.delete(row._id);
  });
}

/**
 * purpose: Run the calendar fan-out chunks for a household the way the scheduler would,
 *          following the cursor until the events are done.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param connectionId: (Id<"calendarConnections">, optional) Push to this connection only.
 * @return: (Promise<number[]>) Syncs queued by each chunk, in order.
 */
export async function runFanOut(
  t: TestConvex,
  householdId: Id<"households">,
  connectionId?: Id<"calendarConnections">,
): Promise<number[]> {
  const sizes: number[] = [];
  let cursor: string | null = null;
  do {
    const result: { queued: number; next: string | null } = await t.mutation(
      internal.calendarFanOut.chunk,
      { householdId, connectionId, cursor },
    );
    sizes.push(result.queued);
    cursor = result.next;
  } while (cursor !== null);
  return sizes;
}

/**
 * purpose: Names of the functions currently scheduled (pending) in the backend.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<string[]>) Scheduled function names, e.g. "calendarFanOut:chunk".
 */
export async function pendingScheduled(t: TestConvex): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect();
    return rows.filter((r) => r.state.kind === "pending").map((r) => r.name);
  });
}

/**
 * purpose: Set a member's phone number, verified or not, directly.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Member.
 * @param phone: (string) E.164 number.
 * @param verified: (boolean) Whether to set phoneVerifiedAt (to the current clock).
 * @param displayName: (string, optional) New display name for the member.
 * @return: (Promise<void>) Resolves when written.
 */
export async function setPhone(
  t: TestConvex,
  householdId: Id<"households">,
  userId: string,
  phone: string,
  verified = true,
  displayName?: string,
): Promise<void> {
  await t.run(async (ctx) => {
    const member = await ctx.db
      .query("householdMembers")
      .withIndex("by_household_user", (q) => q.eq("householdId", householdId).eq("userId", userId))
      .unique();
    await ctx.db.patch(member!._id, {
      phone,
      phoneVerifiedAt: verified ? Date.now() : undefined,
      ...(displayName === undefined ? {} : { displayName }),
    });
  });
}

/**
 * purpose: Insert a task and one of its instances directly. Defaults: local date 2026-10-29,
 *          scheduled 08:00, a two hour window around the current clock, state "escalated".
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param label: (string) Task display label.
 * @param fields: (object) Overrides for any instance field except the ids.
 * @return: (Promise<Id<"taskInstances">>) The instance.
 */
export async function addInstance(
  t: TestConvex,
  householdId: Id<"households">,
  label: string,
  fields: Partial<
    Omit<Doc<"taskInstances">, "_id" | "_creationTime" | "taskId" | "householdId">
  > = {},
): Promise<Id<"taskInstances">> {
  const windowStart = fields.windowStart ?? Date.now() - 60 * 60 * 1000;
  return await t.run(async (ctx) => {
    const taskId = await ctx.db.insert("tasks", {
      householdId,
      type: "medication",
      title: label,
      displayLabel: label,
      spokenPrompt: `Time for ${label}.`,
      checklistItems: [],
      times: [fields.scheduledTime ?? "08:00"],
      windowMinutes: 60,
      createdByKind: "caregiver",
      active: true,
      scheduleChangedAt: 0,
    });
    return await ctx.db.insert("taskInstances", {
      localDate: "2026-10-29",
      scheduledTime: "08:00",
      windowEnd: windowStart + 2 * 60 * 60 * 1000,
      state: "escalated",
      createdAt: windowStart,
      firedSteps: [],
      ...fields,
      taskId,
      householdId,
      windowStart,
    });
  });
}
