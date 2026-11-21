import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import workflowTest from "@convex-dev/workflow/test";
import { convexTest } from "convex-test";
import { getFunctionName, makeFunctionReference } from "convex/server";
import type { FunctionReference, FunctionType } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { AGENT_CONFIG_FINGERPRINT } from "./lib/agentFingerprint";
import type { AgentRequestStatus } from "./lib/validators";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.helpers.ts"]);

export function makeBackend() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  workflowTest.register(t);
  workpoolTest.register(t, "calendarSyncPool");
  workpoolTest.register(t, "deliveryPool");
  workpoolTest.register(t, "mailPool");
  return t;
}

export type TestConvex = ReturnType<typeof makeBackend>;

export function withUncheckedArgs<Ref extends FunctionReference<FunctionType>>(
  ref: Ref,
): FunctionReference<Ref["_type"], "public", Record<string, unknown>, Ref["_returnType"]> {
  return makeFunctionReference<Ref["_type"], Record<string, unknown>, Ref["_returnType"]>(
    getFunctionName(ref),
  );
}

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

export async function insertRequest(
  t: TestConvex,
  householdId: Id<"households">,
  fields: Partial<{
    message: string;
    status: AgentRequestStatus;
    sessionId: string;
    reply: string;
    error: string;
    finishedAt: number;
    requestedBy: string;
    continueRequestId: Id<"agentRequests">;
    agentConfig: string;
  }> = {},
): Promise<Id<"agentRequests">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("agentRequests", {
      householdId,
      requestedBy: "user_a",
      message: "hello",
      status: "queued",
      agentConfig: AGENT_CONFIG_FINGERPRINT,
      ...fields,
    });
  });
}

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

const FAR_FUTURE = "2099-06-01";

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

export async function addMember(
  t: TestConvex,
  householdId: Id<"households">,
  userId: string,
  role: Doc<"householdMembers">["role"] = "member",
  displayName: string = userId,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("householdMembers", { householdId, userId, role, displayName });
  });
}

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

export async function syncRows(t: TestConvex): Promise<Doc<"calendarSyncs">[]> {
  return await t.run(async (ctx) => await ctx.db.query("calendarSyncs").collect());
}

export async function clearSyncs(t: TestConvex): Promise<void> {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("calendarSyncs").collect()) await ctx.db.delete(row._id);
  });
}

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

export async function pendingScheduled(t: TestConvex): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect();
    return rows.filter((r) => r.state.kind === "pending").map((r) => r.name);
  });
}

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
      highPriority: false,
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
