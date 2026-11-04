// agentTools.test.ts
// Purpose: Tests for lib/agentTools.ts and lib/agentBriefing.ts with convex-test. Covers
// the tool definitions, each tool's happy path and effect on the events and audit tables
// (createdVia "agent"), field mapping (weekday names to ISO numbers, empty repeat list to
// null, nulls clearing fields), tool errors for malformed input, unknown fields, invalid or
// foreign event ids, past dates and unknown tools, household isolation, the get_calendar
// result shape (event_id), and buildBriefing for an empty and a populated week, DST-safe
// local times and an unknown requester. Task tools: get_tasks shape, active-only listing,
// type filter and size cap, add_task (defaults, today's instances, validation, the label cap,
// the server-side time rule and the duplicate guard), update_task (mapping, null clearing,
// every-day weekdays, resume, the time rule on the merged result), stop_task (history kept,
// upcoming instances removed, no delete), the field mapping toTaskChanges (add vs update key
// sets, no as-needed fields), household isolation, and the task part of the briefing (task_id,
// carry-over and who confirmed). Provenance: tasks and events the agent adds record the
// requesting caregiver as createdBy, and audit rows record the requester and request id.
// Also the default escalation policy add_task assigns by type, tasks with older long labels
// staying stoppable and editable, the as-needed medication refusal in update_task (stop_task
// allowed, briefing marker), size caps on add_task, the schedule-aware duplicate guard on
// add_task and update_task, the toTaskChanges field table, and the briefing's over-cap
// selection and times cap. Anytime tasks (no times, not a medication): add_task without times,
// refusal for a medication, update_task to anytime and back (policy handling), the duplicate
// guard for two anytime tasks, and get_tasks and the briefing showing "anytime".
//
// Last modified: 2026-11-04

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { AGENT_MODEL, AGENT_NAME, AGENT_SYSTEM_PROMPT } from "./lib/agentConfig";
import { buildBriefing } from "./lib/agentBriefing";
import { listTasksCore } from "./tasks";
import {
  AGENT_TOOLS,
  executeAgentTool,
  MAX_TOOL_RESULT_CHARS,
  toEventChanges,
  toTaskChanges,
} from "./lib/agentTools";
import { createHousehold, insertRequest, makeBackend, type TestConvex } from "./testing.helpers";

const NY = "America/New_York";
/** Monday 2027-03-01, 07:00 in New York (EST). */
const NOW = Date.parse("2027-03-01T12:00:00Z");

/** A harness with two households, each with one primary caregiver. */
interface World {
  t: TestConvex;
  a: Id<"households">;
  b: Id<"households">;
}

/**
 * purpose: Create two households through the real households functions.
 * @return: (Promise<World>) Harness and both household ids.
 */
async function makeWorld(): Promise<World> {
  const t = makeBackend();
  const a = await createHousehold(t, { timezone: NY });
  const b = await createHousehold(t, {
    subject: "user_b",
    seniorName: "Walter",
    caregiverName: "Ben",
    timezone: NY,
  });
  return { t, a, b };
}

/** Result of a tool call. */
interface ToolResult {
  text: string;
  isError: boolean;
}

/**
 * purpose: Insert an agent request row, for tests that check the request id on audit rows.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Id<"agentRequests">>) The request id.
 */
async function makeRequest(
  t: TestConvex,
  householdId: Id<"households">,
): Promise<Id<"agentRequests">> {
  return await insertRequest(t, householdId, { status: "running" });
}

/**
 * purpose: Run a tool inside a mutation, as the runtime does: an agent actor acting for the
 *          requesting caregiver.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household of the request.
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input.
 * @param now: (number) Epoch ms.
 * @param requestedBy: (string) Requesting caregiver's user id (default user_a).
 * @param requestId: (Id<"agentRequests">, optional) The request, recorded on audit rows.
 * @return: (Promise<ToolResult>) The tool result.
 */
async function tool(
  t: TestConvex,
  householdId: Id<"households">,
  name: string,
  input: Record<string, unknown>,
  now: number = NOW,
  requestedBy: string = "user_a",
  requestId?: Id<"agentRequests">,
): Promise<ToolResult> {
  const actor = { kind: "agent", onBehalfOf: requestedBy, requestId } as const;
  return await t.run(
    async (ctx) => await executeAgentTool(ctx, { householdId, actor, now }, { name, input }),
  );
}

/**
 * purpose: Build the briefing in a query context.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param requestedBy: (string | null) Requesting user id (default user_a).
 * @param now: (number) Epoch ms.
 * @return: (Promise<string>) Briefing.
 */
async function briefing(
  t: TestConvex,
  householdId: Id<"households">,
  requestedBy: string | null = "user_a",
  now: number = NOW,
): Promise<string> {
  return await t.run(async (ctx) => await buildBriefing(ctx, householdId, requestedBy, now));
}

/**
 * purpose: Add an event through the add_event tool and return its id.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param input: (Record<string, unknown>) add_event input.
 * @return: (Promise<Id<"events">>) The new event's id.
 */
async function addViaTool(
  t: TestConvex,
  householdId: Id<"households">,
  input: Record<string, unknown>,
): Promise<Id<"events">> {
  const result = await tool(t, householdId, "add_event", input);
  expect(result.isError).toBe(false);
  return JSON.parse(result.text).eventId as Id<"events">;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("definitions", () => {
  test("exposes the eight tools with their snake_case names", () => {
    expect(AGENT_TOOLS.map((x) => ("name" in x ? x.name : x.type))).toEqual([
      "get_tasks",
      "add_task",
      "update_task",
      "stop_task",
      "get_calendar",
      "add_event",
      "update_event",
      "cancel_event",
    ]);
  });

  test("keeps the agent config values", () => {
    expect(AGENT_NAME).toBe("Sunny household agent");
    expect(AGENT_MODEL).toBe("claude-opus-5-5");
    expect(AGENT_SYSTEM_PROMPT).toContain("Sunny's household agent");
  });

  test("the prompt says not to act on the earlier-conversation section", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("Earlier in this conversation");
    expect(AGENT_SYSTEM_PROMPT).toContain("It is context only");
    expect(AGENT_SYSTEM_PROMPT).toContain("Never carry out, retry or finish anything asked in it");
    expect(AGENT_SYSTEM_PROMPT).toContain(
      "directly answers a question in your most recent reply in that section",
    );
    expect(AGENT_SYSTEM_PROMPT).toContain("An apparent answer to any older question is not one");
    expect(AGENT_SYSTEM_PROMPT).toContain("ask the caregiver whether they still want it");
  });

  test("every tool the prompt names exists, and the prompt does not offer as-needed limits", () => {
    const names = AGENT_TOOLS.map((x) => ("name" in x ? x.name : x.type));
    const mentioned = AGENT_SYSTEM_PROMPT.match(/\b(?:get|add|update|stop|cancel)_[a-z]+\b/g) ?? [];
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) expect(names).toContain(name);
    expect(AGENT_SYSTEM_PROMPT).not.toContain("as_needed_");
  });

  test("the task tools expose no as-needed fields, and add_task has no active", () => {
    const schemas = JSON.stringify(AGENT_TOOLS);
    expect(schemas).not.toContain("as_needed");
    const addTask = AGENT_TOOLS.find((x) => "name" in x && x.name === "add_task") as {
      input_schema: { properties: object };
    };
    expect(Object.keys(addTask.input_schema.properties)).not.toContain("active");
  });
});

describe("toEventChanges", () => {
  test("maps weekdays to ISO numbers and field names to camelCase", () => {
    expect(
      toEventChanges({
        title: "Walk",
        date: "2027-03-02",
        start_time: "09:30",
        visitor_name: "Dana",
        repeat_weekdays: ["mon", "sun"],
        repeat_until: "2027-04-01",
        duration_minutes: 45,
      }),
    ).toEqual({
      title: "Walk",
      onDate: "2027-03-02",
      startTime: "09:30",
      visitorName: "Dana",
      repeatDays: [1, 7],
      repeatUntil: "2027-04-01",
      durationMinutes: 45,
    });
  });

  test("maps an empty or null repeat list to null and keeps nulls", () => {
    expect(toEventChanges({ repeat_weekdays: [], place: null })).toEqual({
      repeatDays: null,
      place: null,
    });
    expect(toEventChanges({ repeat_weekdays: null })).toEqual({ repeatDays: null });
  });

  test.each([
    [{ bogus: 1 }, "Unknown field bogus"],
    [{ repeat_weekdays: ["funday"] }, "repeat_weekdays"],
    [{ repeat_weekdays: "mon" }, "repeat_weekdays"],
    [{ duration_minutes: "ten" }, "duration_minutes"],
    [{ duration_minutes: 1.5 }, "duration_minutes must be a whole number"],
    [{ place: 5 }, "place must be a string"],
    [{ title: null }, "title is missing or malformed"],
  ])("rejects %j", (fields, message) => {
    expect(() => toEventChanges(fields)).toThrow(message);
  });
});

describe("add_event", () => {
  test("adds an agent event and audits it", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "add_event", {
      title: "Physiotherapy",
      label: "Exercises with Dana",
      date: "2027-03-04",
      start_time: "14:00",
      duration_minutes: 45,
      place: "Clinic",
      visitor_name: "Dana",
      notes: "Bring shoes",
    });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.title).toBe("Physiotherapy");
    expect(body.createdVia).toBe("agent");
    const rows = await t.run(async (ctx) => await ctx.db.query("events").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      householdId: a,
      startsOn: "2027-03-04",
      startTime: "14:00",
      durationMinutes: 45,
      place: "Clinic",
      visitorName: "Dana",
      label: "Exercises with Dana",
      createdVia: "agent",
    });
    const log = await t.run(async (ctx) => {
      const all = await ctx.db.query("auditLog").collect();
      return all.filter((r) => r.entity === "event");
    });
    expect(log).toHaveLength(1);
    expect(log[0]!).toMatchObject({ action: "insert", actorKind: "agent", entityId: rows[0]!._id });
  });

  test("records the requester as createdBy and in the audit row, with the request id", async () => {
    const { t, a } = await makeWorld();
    const requestId = await makeRequest(t, a);
    const input = { title: "Call", date: "2027-03-02", start_time: "10:00" };
    expect((await tool(t, a, "add_event", input, NOW, "user_a", requestId)).isError).toBe(false);
    const { event, audit } = await t.run(async (ctx) => ({
      event: (await ctx.db.query("events").collect())[0]!,
      audit: (await ctx.db.query("auditLog").collect()).find((r) => r.entity === "event")!,
    }));
    expect(event).toMatchObject({ createdVia: "agent", createdBy: "user_a" });
    expect(audit).toMatchObject({
      actorKind: "agent",
      actorUserId: "user_a",
      detail: expect.objectContaining({ requestId }),
    });
  });

  test("treats null optional fields as absent", async () => {
    const { t, a } = await makeWorld();
    await addViaTool(t, a, {
      title: "Call",
      date: "2027-03-02",
      start_time: "10:00",
      place: null,
      repeat_weekdays: [],
    });
    const rows = await t.run(async (ctx) => await ctx.db.query("events").collect());
    expect(rows[0]!.place).toBeUndefined();
    expect(rows[0]!.repeatDays).toBeUndefined();
  });

  test.each([
    [{ date: "2027-03-02", start_time: "10:00" }, "title, date and start_time are required"],
    [{ title: "x", start_time: "10:00" }, "title, date and start_time are required"],
    [{ title: "x", date: "2027-03-02", start_time: "10:00", color: "red" }, "Unknown field color"],
    [{ title: "x", date: "2027-02-28", start_time: "10:00" }, "That time has already passed"],
  ])("returns a tool error for %j", async (input, message) => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "add_event", input);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Error: `);
    expect(result.text).toContain(message);
    const rows = await t.run(async (ctx) => await ctx.db.query("events").collect());
    expect(rows).toHaveLength(0);
  });
});

describe("update_event", () => {
  test("changes only the sent fields and audits the update", async () => {
    const { t, a } = await makeWorld();
    const id = await addViaTool(t, a, {
      title: "Visit",
      date: "2027-03-04",
      start_time: "14:00",
      place: "Home",
    });
    const result = await tool(t, a, "update_event", {
      event_id: id,
      changes: { start_time: "15:30", title: "Family visit" },
    });
    expect(result.isError).toBe(false);
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row).toMatchObject({ title: "Family visit", startTime: "15:30", place: "Home" });
    const log = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(log.some((r) => r.action === "update" && r.actorKind === "agent")).toBe(true);
  });

  test("an empty repeat list makes a repeating event one-off and null clears a field", async () => {
    const { t, a } = await makeWorld();
    const id = await addViaTool(t, a, {
      title: "Yoga",
      date: "2027-03-02",
      start_time: "10:00",
      place: "Hall",
      repeat_weekdays: ["tue"],
    });
    const result = await tool(t, a, "update_event", {
      event_id: id,
      changes: { repeat_weekdays: [], place: null },
    });
    expect(result.isError).toBe(false);
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.repeatDays).toBeUndefined();
    expect(row?.place).toBeUndefined();
  });

  test.each([
    [{ event_id: "not-an-id", changes: { title: "x" } }, "not a valid event id"],
    [{ changes: { title: "x" } }, "event_id is missing"],
    [{ event_id: "ID", changes: "nope" }, "changes must be an object"],
    [{ event_id: "ID", changes: ["x"] }, "changes must be an object"],
    [{ event_id: "ID", changes: { bogus: 1 } }, "Unknown field bogus"],
  ])("returns a tool error for %j", async (input, message) => {
    const { t, a } = await makeWorld();
    const id = await addViaTool(t, a, { title: "Visit", date: "2027-03-04", start_time: "14:00" });
    const fixed: Record<string, unknown> = { ...input };
    if (fixed.event_id === "ID") fixed.event_id = id;
    const result = await tool(t, a, "update_event", fixed);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
  });

  test("an id of another table is a tool error", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "update_event", { event_id: a, changes: { title: "x" } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a valid event id");
  });

  test("an event of another household cannot be updated", async () => {
    const { t, a, b } = await makeWorld();
    const foreign = await addViaTool(t, b, {
      title: "Walter's visit",
      date: "2027-03-04",
      start_time: "14:00",
    });
    const result = await tool(t, a, "update_event", {
      event_id: foreign,
      changes: { title: "Hijacked" },
    });
    expect(result).toEqual({ text: "Error: Event not found", isError: true });
    const row = await t.run(async (ctx) => await ctx.db.get(foreign));
    expect(row?.title).toBe("Walter's visit");
  });
});

describe("cancel_event", () => {
  test("soft deletes the event and audits the cancellation", async () => {
    const { t, a } = await makeWorld();
    const id = await addViaTool(t, a, { title: "Visit", date: "2027-03-04", start_time: "14:00" });
    const result = await tool(t, a, "cancel_event", { event_id: id });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).eventId).toBe(id);
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.deletedAt).toBe(NOW);
    const log = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(log.some((r) => r.action === "cancel" && r.actorKind === "agent")).toBe(true);
  });

  test("an event of another household cannot be cancelled", async () => {
    const { t, a, b } = await makeWorld();
    const foreign = await addViaTool(t, b, {
      title: "Visit",
      date: "2027-03-04",
      start_time: "14:00",
    });
    const result = await tool(t, a, "cancel_event", { event_id: foreign });
    expect(result.isError).toBe(true);
    const row = await t.run(async (ctx) => await ctx.db.get(foreign));
    expect(row?.deletedAt).toBeUndefined();
  });
});

describe("get_calendar", () => {
  test("returns occurrences carrying event_id, fields, local date and start time", async () => {
    const { t, a } = await makeWorld();
    const id = await addViaTool(t, a, {
      title: "Yoga",
      date: "2027-03-02",
      start_time: "10:00",
      repeat_weekdays: ["tue", "thu"],
      repeat_until: "2027-03-11",
    });
    const result = await tool(t, a, "get_calendar", {
      from_date: "2027-03-01",
      to_date: "2027-03-31",
    });
    expect(result.isError).toBe(false);
    const items = JSON.parse(result.text);
    expect(items.map((i: { local_date: string }) => i.local_date)).toEqual([
      "2027-03-02",
      "2027-03-04",
      "2027-03-09",
      "2027-03-11",
    ]);
    expect(items[0]).toMatchObject({
      event_id: id,
      title: "Yoga",
      label: "Yoga",
      start_time: "10:00",
      repeat_weekdays: ["tue", "thu"],
      repeat_until: "2027-03-11",
      created_via: "agent",
      cancelled: false,
    });
    expect(typeof items[0].starts_at).toBe("number");
  });

  test("does not list another household's or cancelled events", async () => {
    const { t, a, b } = await makeWorld();
    await addViaTool(t, b, { title: "Theirs", date: "2027-03-04", start_time: "14:00" });
    const mine = await addViaTool(t, a, { title: "Mine", date: "2027-03-04", start_time: "15:00" });
    await tool(t, a, "cancel_event", { event_id: mine });
    const result = await tool(t, a, "get_calendar", {
      from_date: "2027-03-01",
      to_date: "2027-03-31",
    });
    expect(JSON.parse(result.text)).toEqual([]);
  });

  test.each([
    [{ from_date: "2027-03-01" }, "to_date is missing"],
    [{ from_date: "soon", to_date: "2027-03-31" }, "Dates must be YYYY-MM-DD"],
    [{ from_date: "2027-01-01", to_date: "2027-06-01" }, "Date range must be 0 to 92 days"],
  ])("returns a tool error for %j", async (input, message) => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "get_calendar", input);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
  });
});

describe("oversized results", () => {
  test("get_calendar over the cap is a tool error asking for a shorter range", async () => {
    const { t, a } = await makeWorld();
    for (let i = 0; i < 60; i++) {
      await addViaTool(t, a, {
        title: `Event ${i}`,
        date: "2027-03-04",
        start_time: "14:00",
        notes: "n".repeat(1000),
      });
    }
    const result = await tool(t, a, "get_calendar", {
      from_date: "2027-03-01",
      to_date: "2027-03-31",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Ask for something narrower");
    expect(result.text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });
});

describe("unknown tool", () => {
  test("is a tool error naming the tool", async () => {
    const { t, a } = await makeWorld();
    expect(await tool(t, a, "delete_everything", {})).toEqual({
      text: "Unknown tool delete_everything",
      isError: true,
    });
  });
});

describe("buildBriefing", () => {
  test("an empty week says nothing is scheduled", async () => {
    const { t, a } = await makeWorld();
    expect(await briefing(t, a, "user_a")).toBe(
      [
        "Household briefing (from Sunny's records):",
        "- Senior: Margaret",
        `- Timezone: ${NY}`,
        "- Now: Monday, 2027-03-01T07:00:00 local",
        "- Requested by: Anna",
        "- Calendar, today and the next 7 days:",
        "  (nothing scheduled)",
        "- Active tasks, with today's status:",
        "  (none)",
      ].join("\n"),
    );
  });

  test("lists today and the next 7 days with event ids, earliest first", async () => {
    const { t, a } = await makeWorld();
    const today = await addViaTool(t, a, {
      title: "Pills",
      date: "2027-03-01",
      start_time: "20:00",
    });
    const later = await addViaTool(t, a, {
      title: "Visit",
      date: "2027-03-08",
      start_time: "09:15",
    });
    await addViaTool(t, a, { title: "Too far", date: "2027-03-09", start_time: "09:00" });
    const text = await briefing(t, a, "user_a");
    expect(text).toContain(`- 2027-03-01 20:00 Pills (event_id ${today})`);
    expect(text).toContain(`- 2027-03-08 09:15 Visit (event_id ${later})`);
    expect(text).not.toContain("Too far");
    expect(text).not.toContain("nothing scheduled");
    expect(text.indexOf("Pills")).toBeLessThan(text.indexOf("Visit"));
  });

  test("shows household-local times across a DST change", async () => {
    const { t, a } = await makeWorld();
    const now = Date.parse("2027-03-12T15:00:00Z");
    vi.setSystemTime(now);
    // DST starts 2027-03-14; a weekly 09:00 event stays at 09:00 local on both sides.
    await tool(
      t,
      a,
      "add_event",
      {
        title: "Walk",
        date: "2027-03-13",
        start_time: "09:00",
        repeat_weekdays: ["sat", "sun", "mon"],
      },
      now,
    );
    const text = await briefing(t, a, "user_a", now);
    expect(text).toContain("- Now: Friday, 2027-03-12T10:00:00 local");
    expect(text).toMatch(/- 2027-03-13 09:00 Walk/);
    expect(text).toMatch(/- 2027-03-14 09:00 Walk/);
    expect(text).toMatch(/- 2027-03-15 09:00 Walk/);
  });

  test("an unknown or absent requester is a caregiver", async () => {
    const { t, a } = await makeWorld();
    expect(await briefing(t, a, "user_zzz")).toContain("- Requested by: a caregiver");
    expect(await briefing(t, a, null)).toContain("- Requested by: a caregiver");
  });

  test("a member of another household is not named", async () => {
    const { t, a } = await makeWorld();
    expect(await briefing(t, a, "user_b")).toContain("- Requested by: a caregiver");
  });
});

/** add_task input for a daily pill task at 08:00. */
const PILLS = {
  type: "medication",
  title: "Morning pills",
  display_label: "Morning pills",
  times: ["08:00"],
};

/**
 * purpose: Read all task rows and their instances.
 * @param t: (TestConvex) Harness.
 * @return: The tasks and instances.
 */
async function readTasks(t: TestConvex) {
  return await t.run(async (ctx) => ({
    tasks: await ctx.db.query("tasks").collect(),
    instances: await ctx.db.query("taskInstances").collect(),
    audits: (await ctx.db.query("auditLog").collect()).filter((a) => a.entity === "task"),
  }));
}

/**
 * purpose: Add a task through add_task and return its id.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param input: (Record<string, unknown>) add_task input.
 * @return: (Promise<string>) The task_id.
 */
async function addTask(
  t: TestConvex,
  householdId: Id<"households">,
  input: Record<string, unknown> = PILLS,
): Promise<string> {
  const result = await tool(t, householdId, "add_task", input);
  expect(result.isError).toBe(false);
  return JSON.parse(result.text).task_id as string;
}

describe("toTaskChanges", () => {
  test("maps names, weekdays and nulls", () => {
    expect(
      toTaskChanges({
        type: "reminder",
        display_label: "Call Kevin",
        spoken_prompt: null,
        repeat_weekdays: ["mon", "sun"],
        once_on: null,
        window_minutes: 30,
        active: true,
      }),
    ).toEqual({
      type: "reminder",
      displayLabel: "Call Kevin",
      spokenPrompt: "",
      daysOfWeek: [1, 7],
      onceOn: null,
      windowMinutes: 30,
      active: true,
    });
  });

  test("an allowed-key list narrows the accepted fields", () => {
    expect(() => toTaskChanges({ active: true }, ["title"])).toThrow("Unknown field active");
    expect(toTaskChanges({ title: "x" }, ["title"])).toEqual({ title: "x" });
  });

  test("null or an empty list for repeat_weekdays means every day", () => {
    expect(toTaskChanges({ repeat_weekdays: [] })).toEqual({ daysOfWeek: null });
    expect(toTaskChanges({ repeat_weekdays: null })).toEqual({ daysOfWeek: null });
  });

  test.each([
    [{ type: "party" }, "type must be one of"],
    [{ repeat_weekdays: ["funday"] }, "mon..sun"],
    [{ times: "08:00" }, "times must be a list of strings"],
    [{ window_minutes: 1.5 }, "whole number"],
    [{ window_minutes: null }, "cannot be cleared"],
    [{ active: "yes" }, "true or false"],
    [{ nope: 1 }, "Unknown field nope"],
    [{ as_needed_max_per_day: 2 }, "Unknown field as_needed_max_per_day"],
    [{ as_needed_min_hours: 4 }, "Unknown field as_needed_min_hours"],
    [{ title: null }, "title is missing or malformed"],
  ])("rejects %j", (fields, message) => {
    expect(() => toTaskChanges(fields as Record<string, unknown>)).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ message: expect.stringContaining(message) }),
      }),
    );
  });
});

describe("add_task", () => {
  test("adds a task with defaults and returns it in model shape", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "add_task", PILLS);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      task_id: expect.any(String),
      type: "medication",
      title: "Morning pills",
      display_label: "Morning pills",
      spoken_prompt: "Time for Morning pills.",
      times: ["08:00"],
      anytime: false,
      repeat_weekdays: null,
      once_on: null,
      starts_on: null,
      ends_on: null,
      window_minutes: 60,
      pill_description: null,
      checklist_items: [],
      active: true,
    });
  });

  test("maps every field", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, {
      type: "checklist",
      title: "Evening routine",
      display_label: "Evening routine",
      spoken_prompt: "Let's get ready for bed.",
      times: ["21:00", "20:00"],
      repeat_weekdays: ["tue", "thu"],
      starts_on: "2027-03-01",
      ends_on: "2027-06-01",
      window_minutes: 90,
      checklist_items: ["Brush teeth", "Lock door"],
      pill_description: "white round",
    });
    const { tasks } = await readTasks(t);
    expect(tasks[0]).toMatchObject({
      spokenPrompt: "Let's get ready for bed.",
      times: ["20:00", "21:00"],
      daysOfWeek: [2, 4],
      startsOn: "2027-03-01",
      endsOn: "2027-06-01",
      windowMinutes: 90,
      checklistItems: ["Brush teeth", "Lock door"],
      pillDescription: "white round",
    });
  });

  test("records the requester as creator and as audit user, with the request id", async () => {
    const { t, a } = await makeWorld();
    const requestId = await makeRequest(t, a);
    await tool(t, a, "add_task", PILLS, NOW, "user_a", requestId);
    const { tasks, audits } = await readTasks(t);
    expect(tasks[0]).toMatchObject({ createdByKind: "caregiver", createdBy: "user_a" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "agent",
      actorUserId: "user_a",
      action: "insert",
      detail: expect.objectContaining({ requestId }),
    });
  });

  test("an update and a stop are audited with the requester too", async () => {
    const { t, a } = await makeWorld();
    const requestId = await makeRequest(t, a);
    const id = await addTask(t, a);
    await tool(
      t,
      a,
      "update_task",
      { task_id: id, changes: { title: "Pills" } },
      NOW,
      "user_a",
      requestId,
    );
    await tool(t, a, "stop_task", { task_id: id }, NOW, "user_a", requestId);
    const { audits } = await readTasks(t);
    const mine = audits.filter((x) => x.action === "update" && x.detail.requestId === requestId);
    expect(mine).toHaveLength(2);
    expect(mine.every((x) => x.actorUserId === "user_a")).toBe(true);
  });

  test("creates today's instance like an app-created task", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a);
    const { instances } = await readTasks(t);
    expect(instances).toHaveLength(2);
    expect(instances.map((i) => [i.localDate, i.scheduledTime, i.state]).sort()).toEqual([
      ["2027-03-01", "08:00", "upcoming"],
      ["2027-03-02", "08:00", "upcoming"],
    ]);
  });

  test("a one-off task with a date and time", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, {
      type: "reminder",
      title: "Call Kevin",
      display_label: "Call Kevin",
      times: ["15:00"],
      once_on: "2027-03-01",
    });
    const { instances } = await readTasks(t);
    expect(instances).toHaveLength(1);
  });

  test.each([
    [{ ...PILLS, times: [] }, "at least one time"],
    [{ type: "medication", title: "x", display_label: "x" }, "at least one time"],
    [
      { title: "x", display_label: "x", times: ["08:00"] },
      "type, title and display_label are required",
    ],
    [{ ...PILLS, times: ["8am"] }, "must be HH:MM"],
    [{ ...PILLS, times: ["08:00", "08:00"] }, "unique"],
    [{ ...PILLS, once_on: "2027-03-02", repeat_weekdays: ["mon"] }, "cannot also repeat"],
    [{ ...PILLS, window_minutes: 5000 }, "Window must be"],
    [{ ...PILLS, as_needed_max_per_day: 2 }, "Unknown field as_needed_max_per_day"],
    [{ ...PILLS, display_label: "x".repeat(61) }, "Display label is too long (60 at most)"],
    [{ ...PILLS, title: "x".repeat(201) }, "Title is too long (200 at most)"],
    [{ ...PILLS, title: "  " }, "title cannot be blank"],
    [{ ...PILLS, active: false }, "Unknown field active"],
    [{ ...PILLS, household_id: "x" }, "Unknown field household_id"],
  ])("rejects %j", async (input, message) => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "add_task", input);
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain(message);
    expect((await readTasks(t)).tasks).toHaveLength(0);
  });
});

describe("add_task label and title limits", () => {
  test("accepts a 60 character label and a 200 character title", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, { ...PILLS, display_label: "x".repeat(60), title: "y".repeat(200) });
    expect((await readTasks(t)).tasks).toHaveLength(1);
  });
});

describe("add_task duplicate guard", () => {
  test("refuses an active task with the same type, label and a shared time, naming it", async () => {
    const { t, a } = await makeWorld();
    const first = await addTask(t, a, { ...PILLS, times: ["08:00", "20:00"] });
    const result = await tool(t, a, "add_task", {
      ...PILLS,
      display_label: "  morning   PILLS ",
      times: ["20:00", "21:00"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`task_id ${first}`);
    expect((await readTasks(t)).tasks).toHaveLength(1);
  });

  test.each([
    ["a different label", { display_label: "Evening pills" }],
    ["a different type", { type: "routine" }],
    ["no shared time", { times: ["09:00"] }],
  ])("allows %s", async (_name, change) => {
    const { t, a } = await makeWorld();
    await addTask(t, a);
    await addTask(t, a, { ...PILLS, ...change });
    expect((await readTasks(t)).tasks).toHaveLength(2);
  });

  test("a stopped task or another household's task is not a duplicate", async () => {
    const { t, a, b } = await makeWorld();
    const stopped = await addTask(t, a);
    await tool(t, a, "stop_task", { task_id: stopped });
    await addTask(t, b);
    await addTask(t, a);
    expect((await readTasks(t)).tasks).toHaveLength(3);
  });
});

describe("get_tasks", () => {
  test("filters by type", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a);
    await addTask(t, a, { ...PILLS, type: "routine", title: "Walk", display_label: "Walk" });
    const only = JSON.parse((await tool(t, a, "get_tasks", { type: "routine" })).text);
    expect(only.map((x: { title: string }) => x.title)).toEqual(["Walk"]);
    expect((await tool(t, a, "get_tasks", { type: "party" })).isError).toBe(true);
  });

  test("lists active tasks in creation order and hides stopped ones by default", async () => {
    const { t, a } = await makeWorld();
    const first = await addTask(t, a);
    await addTask(t, a, {
      ...PILLS,
      title: "Evening pills",
      display_label: "Evening",
      times: ["20:00"],
    });
    await tool(t, a, "stop_task", { task_id: first });
    const active = JSON.parse((await tool(t, a, "get_tasks", {})).text);
    expect(active.map((x: { title: string }) => x.title)).toEqual(["Evening pills"]);
    const all = JSON.parse((await tool(t, a, "get_tasks", { include_stopped: true })).text);
    expect(all.map((x: { title: string }) => x.title)).toEqual(["Morning pills", "Evening pills"]);
    expect(all[0]).toMatchObject({ task_id: first, active: false });
  });

  test("shows weekday names", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, { ...PILLS, repeat_weekdays: ["wed", "mon"] });
    const [task] = JSON.parse((await tool(t, a, "get_tasks", {})).text);
    expect(task.repeat_weekdays).toEqual(["mon", "wed"]);
  });

  test("does not list another household's tasks", async () => {
    const { t, a, b } = await makeWorld();
    await addTask(t, b);
    expect(JSON.parse((await tool(t, a, "get_tasks", {})).text)).toEqual([]);
  });

  test("rejects a malformed include_stopped", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "get_tasks", { include_stopped: "yes" });
    expect(result).toMatchObject({ isError: true });
  });

  test("a result over the cap becomes a tool error", async () => {
    const { t, a } = await makeWorld();
    for (let i = 0; i < 8; i++) {
      await addTask(t, a, {
        ...PILLS,
        title: `Pills ${i}`,
        display_label: `Pills ${i}`,
        times: [`0${i}:00`],
        checklist_items: Array.from({ length: 40 }, () => "x".repeat(200)),
      });
    }
    const result = await tool(t, a, "get_tasks", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Ask for something narrower");
    expect(result.text).toContain("without include_stopped, or with a type");
    expect(result.text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });
});

describe("listTasksCore", () => {
  test("activeOnly reads only active tasks, in creation order", async () => {
    const { t, a, b } = await makeWorld();
    const first = await addTask(t, a);
    await addTask(t, a, { ...PILLS, title: "Walk", display_label: "Walk", type: "routine" });
    await addTask(t, b);
    await tool(t, a, "stop_task", { task_id: first });
    const { active, all } = await t.run(async (ctx) => ({
      active: (await listTasksCore(ctx, a, true)).map((x) => x.title),
      all: (await listTasksCore(ctx, a)).map((x) => x.title),
    }));
    expect(active).toEqual(["Walk"]);
    expect(all).toEqual(["Morning pills", "Walk"]);
  });
});

describe("update_task", () => {
  test("an update cannot leave an active task with no times", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    const result = await tool(t, a, "update_task", { task_id: id, changes: { times: [] } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("at least one time");
    expect((await readTasks(t)).tasks[0]!.times).toEqual(["08:00"]);
  });

  test("resuming a task that has no times is refused, stopping one is fine", async () => {
    const { t, a } = await makeWorld();
    // A stopped task with no times, like an as-needed medication made in the app.
    const taskId = await addTask(t, a);
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId as Id<"tasks">, { times: [], active: false });
    });
    const resumed = await tool(t, a, "update_task", { task_id: taskId, changes: { active: true } });
    expect(resumed.isError).toBe(true);
    expect(resumed.text).toContain("at least one time");
    const withTime = await tool(t, a, "update_task", {
      task_id: taskId,
      changes: { active: true, times: ["09:00"] },
    });
    expect(withTime.isError).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId as Id<"tasks">, { times: [] });
    });
    expect((await tool(t, a, "stop_task", { task_id: taskId })).isError).toBe(false);
  });

  test("changes only the given fields and resyncs instances", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    const result = await tool(t, a, "update_task", {
      task_id: id,
      changes: { times: ["09:30"], display_label: "Pills" },
    });
    expect(JSON.parse(result.text)).toMatchObject({
      times: ["09:30"],
      display_label: "Pills",
      title: "Morning pills",
    });
    const { instances, audits } = await readTasks(t);
    expect(instances.every((i) => i.scheduledTime === "09:30")).toBe(true);
    expect(audits.map((x) => [x.actorKind, x.action])).toEqual([
      ["agent", "insert"],
      ["agent", "update"],
    ]);
  });

  test("null clears optional fields and an empty repeat list means every day", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a, {
      ...PILLS,
      repeat_weekdays: ["mon"],
      pill_description: "blue",
      ends_on: "2027-12-31",
    });
    const result = await tool(t, a, "update_task", {
      task_id: id,
      changes: { repeat_weekdays: [], pill_description: null, ends_on: null },
    });
    expect(JSON.parse(result.text)).toMatchObject({
      repeat_weekdays: null,
      pill_description: null,
      ends_on: null,
    });
  });

  test("null repeat_weekdays also means every day", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a, { ...PILLS, repeat_weekdays: ["mon"] });
    const result = await tool(t, a, "update_task", {
      task_id: id,
      changes: { repeat_weekdays: null },
    });
    expect(JSON.parse(result.text).repeat_weekdays).toBeNull();
  });

  test("a null spoken_prompt restores the default sentence", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a, { ...PILLS, spoken_prompt: "Pills time, Mom." });
    const result = await tool(t, a, "update_task", {
      task_id: id,
      changes: { spoken_prompt: null },
    });
    expect(JSON.parse(result.text).spoken_prompt).toBe("Time for Morning pills.");
  });

  test("active true resumes a stopped task and brings back its instances", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    await tool(t, a, "stop_task", { task_id: id });
    expect((await readTasks(t)).instances).toHaveLength(0);
    const result = await tool(t, a, "update_task", { task_id: id, changes: { active: true } });
    expect(JSON.parse(result.text).active).toBe(true);
    expect((await readTasks(t)).instances.length).toBeGreaterThan(0);
  });

  test.each([
    [(id: string) => ({ task_id: id, changes: { times: ["25:00"] } }), "must be HH:MM"],
    [(id: string) => ({ task_id: id, changes: { bogus: 1 } }), "Unknown field bogus"],
    [(id: string) => ({ task_id: id, changes: "x" }), "changes must be an object"],
    [(id: string) => ({ task_id: id, changes: [] }), "changes must be an object"],
    [() => ({ changes: {} }), "task_id is missing"],
  ])("rejects bad input %#", async (build, message) => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    const result = await tool(t, a, "update_task", build(id));
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
  });

  test("a failed update leaves the task unchanged", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    await tool(t, a, "update_task", { task_id: id, changes: { times: ["99:99"] } });
    expect((await readTasks(t)).tasks[0]!.times).toEqual(["08:00"]);
  });

  test("rejects an id that is not a task id", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "update_task", { task_id: "nonsense", changes: {} });
    expect(result.text).toContain("not a valid task id");
  });
});

describe("stop_task", () => {
  test("stops the task, keeps it and its history, and removes upcoming instances", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    await t.run(async (ctx) => {
      const [first] = await ctx.db.query("taskInstances").collect();
      await ctx.db.patch(first!._id, { state: "confirmed" });
    });
    const result = await tool(t, a, "stop_task", { task_id: id });
    expect(JSON.parse(result.text)).toMatchObject({ task_id: id, active: false });
    const { tasks, instances } = await readTasks(t);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.active).toBe(false);
    expect(instances.map((i) => i.state)).toEqual(["confirmed"]);
  });

  test("stopping twice is fine", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    await tool(t, a, "stop_task", { task_id: id });
    expect((await tool(t, a, "stop_task", { task_id: id })).isError).toBe(false);
  });

  test("there is no delete tool", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    expect((await tool(t, a, "delete_task", { task_id: id })).text).toContain("Unknown tool");
    expect((await readTasks(t)).tasks).toHaveLength(1);
  });
});

describe("task household isolation", () => {
  test("another household's task_id fails like a bad id and is untouched", async () => {
    const { t, a, b } = await makeWorld();
    const foreign = await addTask(t, b);
    for (const [name, input] of [
      ["update_task", { task_id: foreign, changes: { title: "Hijack" } }],
      ["stop_task", { task_id: foreign }],
    ] as const) {
      const result = await tool(t, a, name, input);
      expect(result).toEqual({ text: "Error: Task not found", isError: true });
    }
    const { tasks } = await readTasks(t);
    expect(tasks[0]).toMatchObject({ title: "Morning pills", active: true });
  });

  test("a household_id in the input is rejected, never used", async () => {
    const { t, a, b } = await makeWorld();
    const result = await tool(t, a, "add_task", { ...PILLS, household_id: b });
    expect(result.isError).toBe(true);
    expect((await readTasks(t)).tasks).toHaveLength(0);
  });

  test("a new task belongs to the request's household", async () => {
    const { t, a, b } = await makeWorld();
    await addTask(t, a);
    expect((await readTasks(t)).tasks[0]!.householdId).toBe(a);
    expect(JSON.parse((await tool(t, b, "get_tasks", {})).text)).toEqual([]);
  });
});

describe("briefing tasks", () => {
  test("lists active tasks with task_id, times, weekdays and today's state", async () => {
    const { t, a } = await makeWorld();
    const pills = await addTask(t, a, { ...PILLS, times: ["08:00", "20:00"] });
    const call = await addTask(t, a, {
      type: "reminder",
      title: "Call Kevin",
      display_label: "Call Kevin",
      times: ["15:00"],
      repeat_weekdays: ["mon", "wed"],
    });
    await t.run(async (ctx) => {
      const eight = (await ctx.db.query("taskInstances").collect()).find(
        (i) => i.localDate === "2027-03-01" && i.scheduledTime === "08:00",
      );
      await ctx.db.patch(eight!._id, { state: "confirmed" });
    });
    const text = await briefing(t, a);
    expect(text).toContain("- Active tasks, with today's status:");
    expect(text).toContain(
      `- Morning pills (medication, task_id ${pills}) at 08:00, 20:00 every day; today: 08:00 confirmed, 20:00 upcoming`,
    );
    expect(text).toContain(
      `- Call Kevin (reminder, task_id ${call}) at 15:00 on mon, wed; today: 15:00 upcoming`,
    );
  });

  test("includes yesterday's open carry-over and who confirmed an instance and when", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a, { ...PILLS, times: ["08:00", "23:30"] });
    await t.run(async (ctx) => {
      const eight = (await ctx.db.query("taskInstances").collect()).find(
        (i) => i.localDate === "2027-03-01" && i.scheduledTime === "08:00",
      )!;
      // Resolved by Anna (user_a) at 07:00 local (NOW).
      await ctx.db.patch(eight._id, {
        state: "resolved",
        confirmedAt: NOW,
        confirmedBy: "user_a",
        confirmedVia: "caregiver",
      });
      // Last night's 23:30 dose is still open.
      await ctx.db.insert("taskInstances", {
        taskId: id as Id<"tasks">,
        householdId: a,
        localDate: "2027-02-28",
        scheduledTime: "23:30",
        windowStart: NOW - 7.5 * 3600_000,
        windowEnd: NOW + 0.5 * 3600_000,
        state: "due",
        createdAt: NOW - 8 * 3600_000,
        firedSteps: [],
      });
    });
    const text = await briefing(t, a);
    expect(text).toContain(
      `(medication, task_id ${id}) at 08:00, 23:30 every day; today: yesterday 23:30 due, 08:00 resolved at 07:00 by Anna, 23:30 upcoming`,
    );
  });

  test("does not list a task twice or mix instances of different tasks", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a);
    await addTask(t, a, { ...PILLS, title: "Walk", display_label: "Walk", type: "routine" });
    const lines = (await briefing(t, a)).split("\n").filter((l) => l.includes("task_id"));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.match(/today:/g)).toHaveLength(1);
  });

  test("leaves out stopped tasks and other households' tasks", async () => {
    const { t, a, b } = await makeWorld();
    const id = await addTask(t, a);
    await tool(t, a, "stop_task", { task_id: id });
    await addTask(t, b, { ...PILLS, title: "Walter pills", display_label: "Walter pills" });
    const text = await briefing(t, a);
    expect(text).not.toContain("Morning pills");
    expect(text).not.toContain("Walter pills");
    expect(text).toContain("  (none)");
  });
});

/**
 * purpose: Ids of a household's seeded policies by systemKey.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @return: The medication and prompt_only policy ids.
 */
async function seededPolicies(t: TestConvex, householdId: Id<"households">) {
  const rows = await t.run(
    async (ctx) =>
      await ctx.db
        .query("escalationPolicies")
        .withIndex("by_household", (q) => q.eq("householdId", householdId))
        .collect(),
  );
  return {
    medication: rows.find((p) => p.systemKey === "medication")!._id,
    promptOnly: rows.find((p) => p.systemKey === "prompt_only")!._id,
  };
}

describe("add_task default escalation policy", () => {
  test("a medication task gets the medication policy", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a);
    const { tasks } = await readTasks(t);
    expect(tasks[0]!.escalationPolicyId).toBe((await seededPolicies(t, a)).medication);
  });

  test("a non-medication task gets the prompt_only policy", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, { ...PILLS, type: "routine", title: "Walk", display_label: "Walk" });
    const { tasks } = await readTasks(t);
    expect(tasks[0]!.escalationPolicyId).toBe((await seededPolicies(t, a)).promptOnly);
  });

  test("a household without seeded policies still creates the task with no policy", async () => {
    const { t, a } = await makeWorld();
    await t.run(async (ctx) => {
      for (const p of await ctx.db.query("escalationPolicies").collect())
        await ctx.db.delete(p._id);
    });
    await addTask(t, a);
    const { tasks } = await readTasks(t);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.escalationPolicyId).toBeUndefined();
  });
});

describe("task tools with older long labels", () => {
  /**
   * purpose: Add a task and give it a 100 character label, as older data may have.
   * @param t: (TestConvex) Harness.
   * @param householdId: (Id<"households">) Household.
   * @return: (Promise<string>) The task_id.
   */
  async function longLabelTask(t: TestConvex, householdId: Id<"households">): Promise<string> {
    const id = await addTask(t, householdId);
    await t.run(async (ctx) => {
      await ctx.db.patch(id as Id<"tasks">, { displayLabel: "L".repeat(100) });
    });
    return id;
  }

  test("stop_task and update_task still work, a time change included", async () => {
    const { t, a } = await makeWorld();
    const id = await longLabelTask(t, a);
    const moved = await tool(t, a, "update_task", { task_id: id, changes: { times: ["09:00"] } });
    expect(moved.isError).toBe(false);
    const stopped = await tool(t, a, "stop_task", { task_id: id });
    expect(stopped.isError).toBe(false);
    expect((await readTasks(t)).tasks[0]).toMatchObject({ active: false, times: ["09:00"] });
  });

  test("renaming it to more than 60 characters is refused", async () => {
    const { t, a } = await makeWorld();
    const id = await longLabelTask(t, a);
    const result = await tool(t, a, "update_task", {
      task_id: id,
      changes: { display_label: "x".repeat(61) },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Display label is too long");
  });
});

describe("as-needed medications", () => {
  /**
   * purpose: Add a task, then make it an as-needed medication as the app would (no times).
   * @param t: (TestConvex) Harness.
   * @param householdId: (Id<"households">) Household.
   * @return: (Promise<string>) The task_id.
   */
  async function asNeededTask(t: TestConvex, householdId: Id<"households">): Promise<string> {
    const id = await addTask(t, householdId);
    await t.run(async (ctx) => {
      await ctx.db.patch(id as Id<"tasks">, { times: [], asNeededMaxPerDay: 2 });
    });
    return id;
  }

  test("update_task refuses one with a readable error and changes nothing", async () => {
    const { t, a } = await makeWorld();
    const id = await asNeededTask(t, a);
    const result = await tool(t, a, "update_task", {
      task_id: id,
      changes: { display_label: "Other" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("As-needed medications are managed in the app.");
    expect((await readTasks(t)).tasks[0]!.displayLabel).toBe("Morning pills");
  });

  test("stop_task may still stop one", async () => {
    const { t, a } = await makeWorld();
    const id = await asNeededTask(t, a);
    expect((await tool(t, a, "stop_task", { task_id: id })).isError).toBe(false);
    expect((await readTasks(t)).tasks[0]!.active).toBe(false);
  });

  test("the briefing marks it as managed in the app", async () => {
    const { t, a } = await makeWorld();
    const id = await asNeededTask(t, a);
    expect(await briefing(t, a)).toContain(
      `(medication, task_id ${id}) as needed (managed in the app) every day`,
    );
  });

  test("a task with no times and no as-needed limit is not treated as as-needed", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    await t.run(async (ctx) => {
      await ctx.db.patch(id as Id<"tasks">, { times: [] });
    });
    expect(await briefing(t, a)).toContain("with no times every day");
    const result = await tool(t, a, "update_task", { task_id: id, changes: { times: ["09:00"] } });
    expect(result.isError).toBe(false);
  });
});

describe("add_task size caps", () => {
  test.each([
    ["too many times", { times: Array.from({ length: 25 }, (_, i) => `${i}:00`.padStart(5, "0")) }],
    ["too many checklist items", { checklist_items: Array.from({ length: 51 }, () => "x") }],
    ["a long checklist item", { checklist_items: ["x".repeat(201)] }],
    ["a long spoken prompt", { spoken_prompt: "x".repeat(301) }],
    ["a long pill description", { pill_description: "x".repeat(201) }],
  ])("refuses %s", async (_name, extra) => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "add_task", { ...PILLS, ...extra });
    expect(result.isError).toBe(true);
    expect((await readTasks(t)).tasks).toHaveLength(0);
  });
});

describe("duplicate guard and schedules", () => {
  test("the same label and time on different weekdays is allowed", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, { ...PILLS, repeat_weekdays: ["mon", "tue"] });
    await addTask(t, a, { ...PILLS, repeat_weekdays: ["wed"] });
    expect((await readTasks(t)).tasks).toHaveLength(2);
  });

  test("overlapping weekdays, or every day against a weekday set, is a duplicate", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, { ...PILLS, repeat_weekdays: ["mon", "tue"] });
    const overlap = await tool(t, a, "add_task", { ...PILLS, repeat_weekdays: ["tue", "wed"] });
    const everyDay = await tool(t, a, "add_task", PILLS);
    expect(overlap.isError).toBe(true);
    expect(everyDay.isError).toBe(true);
  });

  test("disjoint date ranges are allowed, overlapping ones are not", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, { ...PILLS, ends_on: "2027-03-31" });
    await addTask(t, a, { ...PILLS, starts_on: "2027-04-01" });
    const overlap = await tool(t, a, "add_task", { ...PILLS, starts_on: "2027-03-31" });
    expect(overlap.isError).toBe(true);
    expect((await readTasks(t)).tasks).toHaveLength(2);
  });

  test("a one-off conflicts only with a task that occurs on its date", async () => {
    const { t, a } = await makeWorld();
    // 2027-03-03 is a Wednesday.
    await addTask(t, a, { ...PILLS, repeat_weekdays: ["mon"] });
    await addTask(t, a, { ...PILLS, once_on: "2027-03-03" });
    const clash = await tool(t, a, "add_task", { ...PILLS, once_on: "2027-03-08" });
    expect(clash.isError).toBe(true);
    expect((await readTasks(t)).tasks).toHaveLength(2);
  });

  test("update_task refuses a rename or time change that duplicates another active task", async () => {
    const { t, a } = await makeWorld();
    const first = await addTask(t, a);
    const second = await addTask(t, a, {
      ...PILLS,
      display_label: "Evening pills",
      times: ["20:00"],
    });
    const rename = await tool(t, a, "update_task", {
      task_id: second,
      changes: { display_label: "morning pills", times: ["08:00"] },
    });
    expect(rename.isError).toBe(true);
    expect(rename.text).toContain(`task_id ${first}`);
    const retime = await tool(t, a, "update_task", {
      task_id: second,
      changes: { times: ["08:00"] },
    });
    expect(retime.isError).toBe(false);
  });

  test("update_task does not count the task itself and allows other edits", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    const same = await tool(t, a, "update_task", {
      task_id: id,
      changes: { display_label: "Morning Pills", times: ["08:00", "12:00"] },
    });
    expect(same.isError).toBe(false);
  });

  test("resuming a stopped task that duplicates an active one is refused", async () => {
    const { t, a } = await makeWorld();
    const stopped = await addTask(t, a);
    await tool(t, a, "stop_task", { task_id: stopped });
    const active = await addTask(t, a);
    const result = await tool(t, a, "update_task", { task_id: stopped, changes: { active: true } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`task_id ${active}`);
  });

  test("a stopped duplicate may be edited while it stays stopped", async () => {
    const { t, a } = await makeWorld();
    const stopped = await addTask(t, a);
    await tool(t, a, "stop_task", { task_id: stopped });
    await addTask(t, a);
    const result = await tool(t, a, "update_task", {
      task_id: stopped,
      changes: { title: "Old pills" },
    });
    expect(result.isError).toBe(false);
  });
});

describe("toTaskChanges field table", () => {
  test("every field of the update_task schema has a reader", () => {
    const update = AGENT_TOOLS.find((x) => "name" in x && x.name === "update_task") as {
      input_schema: { properties: Record<string, { properties: object }> };
    };
    const changes = update.input_schema.properties.changes!;
    for (const key of Object.keys(changes.properties)) {
      let message = "";
      try {
        toTaskChanges({ [key]: null });
      } catch (e) {
        message = JSON.stringify(e);
      }
      expect(message).not.toContain("Unknown field");
    }
  });
});

describe("briefing over the task cap", () => {
  test("keeps tasks with instances today first, then the newest, and counts the rest", async () => {
    const { t, a } = await makeWorld();
    const ids: string[] = [];
    for (let i = 0; i < 32; i += 1) {
      vi.advanceTimersByTime(10);
      ids.push(
        await addTask(t, a, {
          ...PILLS,
          type: "routine",
          title: `Task ${i}`,
          display_label: `Task ${i}`,
        }),
      );
    }
    // Only the oldest task (0) keeps an instance today; the rest have none.
    await t.run(async (ctx) => {
      for (const inst of await ctx.db.query("taskInstances").collect()) {
        if (inst.taskId !== ids[0]) await ctx.db.delete(inst._id);
      }
    });
    const text = await briefing(t, a);
    const lines = text.split("\n").filter((l) => l.includes("task_id"));
    expect(lines).toHaveLength(30);
    expect(text).toContain("Task 0 (routine");
    expect(text).toContain("Task 31 (routine");
    expect(text).toContain("Task 3 (routine");
    expect(text).not.toContain("Task 2 (routine");
    expect(text).not.toContain("Task 1 (routine");
    expect(text).toContain("(and 2 more; use get_tasks)");
  });

  test("shows at most 6 times on a line, then +N more", async () => {
    const { t, a } = await makeWorld();
    await addTask(t, a, {
      ...PILLS,
      times: ["06:00", "07:00", "08:00", "09:00", "10:00", "11:00", "12:00", "13:00"],
    });
    expect(await briefing(t, a)).toContain("at 06:00, 07:00, 08:00, 09:00, 10:00, 11:00, +2 more ");
  });
});

describe("anytime tasks", () => {
  const REMINDER = { type: "reminder", title: "Water the plants", display_label: "Water plants" };

  /**
   * purpose: The seeded policy of a household with the given system key.
   * @param t: (TestConvex) Harness.
   * @param householdId: (Id<"households">) Household.
   * @param key: (string) "medication" or "prompt_only".
   * @return: (Promise<Id<"escalationPolicies"> | undefined>) The policy id.
   */
  async function policyKey(
    t: TestConvex,
    householdId: Id<"households">,
    key: "medication" | "prompt_only",
  ): Promise<Id<"escalationPolicies"> | undefined> {
    return await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("escalationPolicies")
            .withIndex("by_household_system_key", (q) =>
              q.eq("householdId", householdId).eq("systemKey", key),
            )
            .first()
        )?._id,
    );
  }

  test("add_task without times creates an anytime task with no policy and anytime instances", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "add_task", REMINDER);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ times: [], anytime: true });
    const { tasks, instances } = await readTasks(t);
    expect(tasks[0]!.escalationPolicyId).toBeUndefined();
    expect(instances.map((i) => [i.localDate, i.scheduledTime]).sort()).toEqual([
      ["2027-03-01", "anytime"],
      ["2027-03-02", "anytime"],
    ]);
  });

  test("an empty times list is also anytime", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "add_task", { ...REMINDER, times: [] });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ anytime: true });
  });

  test("add_task without times is refused for a medication, telling the model to ask", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "add_task", {
      type: "medication",
      title: "Pills",
      display_label: "Pills",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("A medication needs at least one time");
    expect(result.text).toContain("ask the caregiver");
    expect((await readTasks(t)).tasks).toHaveLength(0);
  });

  test("the add_task schema no longer requires times", () => {
    const addTaskTool = AGENT_TOOLS.find((x) => "name" in x && x.name === "add_task") as {
      input_schema: { required: string[] };
    };
    expect(addTaskTool.input_schema.required).toEqual(["type", "title", "display_label"]);
  });

  test("the prompt tells the agent not to ask for a time for a non-medication task", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("anytime");
    expect(AGENT_SYSTEM_PROMPT).toContain("A medication always needs a time");
  });

  test("two anytime tasks with the same type and label are duplicates; a timed one is not", async () => {
    const { t, a } = await makeWorld();
    const first = await addTask(t, a, REMINDER);
    const dup = await tool(t, a, "add_task", REMINDER);
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain(`task_id ${first}`);
    expect(dup.text).toContain("anytime");
    const timed = await tool(t, a, "add_task", { ...REMINDER, times: ["09:00"] });
    expect(timed.isError).toBe(false);
  });

  test("update_task with empty times makes a timed task anytime and drops its default policy", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a, { ...REMINDER, times: ["09:00"] });
    expect((await readTasks(t)).tasks[0]!.escalationPolicyId).toBe(
      await policyKey(t, a, "prompt_only"),
    );
    const result = await tool(t, a, "update_task", { task_id: id, changes: { times: [] } });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ times: [], anytime: true });
    const { tasks, instances } = await readTasks(t);
    expect(tasks[0]!.escalationPolicyId).toBeUndefined();
    expect(instances.some((i) => i.scheduledTime === "anytime")).toBe(true);
  });

  test("update_task giving an anytime task times restores the type's default policy", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a, REMINDER);
    const result = await tool(t, a, "update_task", { task_id: id, changes: { times: ["10:00"] } });
    expect(result.isError).toBe(false);
    expect((await readTasks(t)).tasks[0]!.escalationPolicyId).toBe(
      await policyKey(t, a, "prompt_only"),
    );
  });

  test("update_task refuses to make a medication anytime", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    const result = await tool(t, a, "update_task", { task_id: id, changes: { times: [] } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("A medication needs at least one time");
    expect((await readTasks(t)).tasks[0]!.times).toEqual(["08:00"]);
  });

  test("update_task changing a timed medication with no times to a reminder is allowed", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a);
    const result = await tool(t, a, "update_task", {
      task_id: id,
      changes: { type: "reminder", times: [] },
    });
    expect(result.isError).toBe(false);
    expect((await readTasks(t)).tasks[0]!.escalationPolicyId).toBeUndefined();
  });

  test("get_tasks and the briefing show anytime tasks as anytime", async () => {
    const { t, a } = await makeWorld();
    const id = await addTask(t, a, REMINDER);
    const listed = JSON.parse((await tool(t, a, "get_tasks", {})).text) as Record<
      string,
      unknown
    >[];
    expect(listed[0]).toMatchObject({ task_id: id, times: [], anytime: true });
    const text = await briefing(t, a);
    expect(text).toContain(`(reminder, task_id ${id}) anytime every day; today: anytime upcoming`);
  });
});
