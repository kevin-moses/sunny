// agentTools.test.ts
// Purpose: Tests for lib/agentTools.ts and lib/agentBriefing.ts with convex-test. Covers
// the tool definitions, each tool's happy path and effect on the events and audit tables
// (createdVia "agent"), field mapping (weekday names to ISO numbers, empty repeat list to
// null, nulls clearing fields), tool errors for malformed input, unknown fields, invalid or
// foreign event ids, past dates and unknown tools, household isolation, the get_calendar
// result shape (event_id), and buildBriefing for an empty and a populated week, DST-safe
// local times and an unknown requester.
//
// Last modified: 2026-10-29

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { AGENT_MODEL, AGENT_NAME, AGENT_SYSTEM_PROMPT } from "./lib/agentConfig";
import { buildBriefing } from "./lib/agentBriefing";
import { AGENT_TOOLS, executeAgentTool, toEventChanges } from "./lib/agentTools";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const NY = "America/New_York";
/** Monday 2027-03-01, 07:00 in New York (EST). */
const NOW = Date.parse("2027-03-01T12:00:00Z");

/**
 * purpose: A fresh in-memory backend.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  return convexTest(schema, modules);
}

/** The convex-test harness type. */
type TestConvex = ReturnType<typeof makeBackend>;

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
  const a = await t.withIdentity({ subject: "user_a" }).mutation(api.households.create, {
    seniorPreferredName: "Margaret",
    timezone: NY,
    caregiverDisplayName: "Anna",
  });
  const b = await t.withIdentity({ subject: "user_b" }).mutation(api.households.create, {
    seniorPreferredName: "Walter",
    timezone: NY,
    caregiverDisplayName: "Ben",
  });
  return { t, a, b };
}

/** Result of a tool call. */
interface ToolResult {
  text: string;
  isError: boolean;
}

/**
 * purpose: Run a tool inside a mutation, as the runtime does.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household of the request.
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input.
 * @param now: (number) Epoch ms.
 * @return: (Promise<ToolResult>) The tool result.
 */
async function tool(
  t: TestConvex,
  householdId: Id<"households">,
  name: string,
  input: Record<string, unknown>,
  now: number = NOW,
): Promise<ToolResult> {
  return await t.run(async (ctx) => await executeAgentTool(ctx, householdId, name, input, now));
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
  test("exposes the four tools with their snake_case names", () => {
    expect(AGENT_TOOLS.map((x) => x.name)).toEqual([
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

  test("maps an empty repeat list to null and keeps nulls", () => {
    expect(toEventChanges({ repeat_weekdays: [], place: null })).toEqual({
      repeatDays: null,
      place: null,
    });
  });

  test.each([
    [{ bogus: 1 }, "Unknown field bogus"],
    [{ repeat_weekdays: ["funday"] }, "repeat_weekdays"],
    [{ repeat_weekdays: "mon" }, "repeat_weekdays"],
    [{ duration_minutes: "ten" }, "duration_minutes"],
    [{ place: 5 }, "place must be a string"],
    [{ title: null }, "title is missing"],
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

  test("stores a weekly repeat with ISO weekdays", async () => {
    const { t, a } = await makeWorld();
    await addViaTool(t, a, {
      title: "Yoga",
      date: "2027-03-02",
      start_time: "10:00",
      repeat_weekdays: ["tue", "thu"],
      repeat_until: "2027-04-01",
    });
    const rows = await t.run(async (ctx) => await ctx.db.query("events").collect());
    expect(rows[0]!.repeatDays).toEqual([2, 4]);
    expect(rows[0]!.repeatUntil).toBe("2027-04-01");
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
    [{ title: "x", date: "March 2", start_time: "10:00" }, "Date must be YYYY-MM-DD"],
    [{ title: "x", date: "2027-03-02", start_time: "25:00" }, "Start time must be HH:MM"],
    [{ title: "x", date: "2027-03-02", start_time: "10:00", duration_minutes: 0 }, "Duration"],
    [{ title: "x", date: "2027-02-28", start_time: "10:00" }, "That time has already passed"],
    [
      { title: "x", date: "2027-03-02", start_time: "10:00", repeat_until: "2027-04-01" },
      "A repeat end needs repeat days",
    ],
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
    [{ event_id: "ID", changes: { date: "2027-02-01" } }, "That time has already passed"],
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

  test("cancelling twice is a tool error", async () => {
    const { t, a } = await makeWorld();
    const id = await addViaTool(t, a, { title: "Visit", date: "2027-03-04", start_time: "14:00" });
    await tool(t, a, "cancel_event", { event_id: id });
    const again = await tool(t, a, "cancel_event", { event_id: id });
    expect(again).toEqual({ text: "Error: Event not found", isError: true });
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

  test("a missing event_id is a tool error", async () => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "cancel_event", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("event_id is missing");
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

  test("the returned event_id works with update_event", async () => {
    const { t, a } = await makeWorld();
    await addViaTool(t, a, { title: "Visit", date: "2027-03-04", start_time: "14:00" });
    const list = JSON.parse(
      (await tool(t, a, "get_calendar", { from_date: "2027-03-04", to_date: "2027-03-04" })).text,
    );
    const result = await tool(t, a, "update_event", {
      event_id: list[0].event_id,
      changes: { start_time: "16:00" },
    });
    expect(result.isError).toBe(false);
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
    [{ from_date: "2027-03-31", to_date: "2027-03-01" }, "Date range must be 0 to 92 days"],
    [{ from_date: "2027-01-01", to_date: "2027-06-01" }, "Date range must be 0 to 92 days"],
  ])("returns a tool error for %j", async (input, message) => {
    const { t, a } = await makeWorld();
    const result = await tool(t, a, "get_calendar", input);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
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
  /**
   * purpose: Build the briefing in a query context.
   * @param t: (TestConvex) Harness.
   * @param householdId: (Id<"households">) Household.
   * @param requestedBy: (string | null) Requesting user id.
   * @param now: (number) Epoch ms.
   * @return: (Promise<string>) Briefing.
   */
  async function briefing(
    t: TestConvex,
    householdId: Id<"households">,
    requestedBy: string | null,
    now: number = NOW,
  ): Promise<string> {
    return await t.run(async (ctx) => await buildBriefing(ctx, householdId, requestedBy, now));
  }

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
    await t.run(async (ctx) => {
      await executeAgentTool(
        ctx,
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
    });
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
