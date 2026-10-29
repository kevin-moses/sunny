// convex/agent.test.ts
// Purpose: Tests for agent.ts, the API the Python voice agent calls. Every function rejects a
// wrong, empty or missing agent key and a deployment without SUNNY_AGENT_KEY. getContext is
// checked against the rules ported from get_agent_context: the exact result shape, as-needed
// doses since local midnight, the 7-day window of events that have not ended, the latest
// caregiver message with the sender's name, life profile ordering, the 50-fact memory cap
// with verified facts first, and the five newest conversation summaries. Also confirmDueTask
// ("voice"), reminders created and cancelled for the senior, and conversation logging
// including the household checks on device and task instance. The agent clock is driven by
// the `now` argument. Also the logTurn length cap, today for an unknown household, and the
// accepted trust model (a valid key may log to or finish any conversation).
//
// Last modified: 2026-10-29

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_TURN_CONTENT_LENGTH } from "./agent";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "agent-secret-key";
/** Wednesday 2027-03-10 10:00 in New York (EST); local midnight is 05:00Z. */
const NOW = Date.parse("2027-03-10T15:00:00Z");
const MIDNIGHT = Date.parse("2027-03-10T05:00:00Z");
const HOUR = 3_600_000;

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.SUNNY_AGENT_KEY;
  process.env.SUNNY_AGENT_KEY = KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.SUNNY_AGENT_KEY;
  else process.env.SUNNY_AGENT_KEY = savedKey;
});

/**
 * purpose: A fresh in-memory backend.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  return convexTest(schema, modules);
}

/** The convex-test harness type. */
type TestConvex = ReturnType<typeof makeBackend>;

/** A household created through the public API (so the default policies exist). */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  conversationId: Id<"conversations">;
}

/** The harness and household, which is all the insert helpers need. */
type World = Pick<Fixture, "t" | "householdId">;

/**
 * purpose: Create a household for Margaret in New York with caregiver Anna (user_a).
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(): Promise<Fixture> {
  const t = makeBackend();
  const householdId = await t.withIdentity({ subject: "user_a" }).mutation(api.households.create, {
    seniorPreferredName: "Margaret",
    timezone: "America/New_York",
    caregiverDisplayName: "Anna",
  });
  const conversationId = await t.run(
    async (ctx) =>
      await ctx.db.insert("conversations", { householdId, trigger: "talk", startedAt: NOW }),
  );
  return { t, householdId, conversationId };
}

/**
 * purpose: Insert a task directly.
 * @param f: (World) Harness and household.
 * @param fields: (object) Overrides for the task row.
 * @return: (Promise<Id<"tasks">>) The task.
 */
async function insertTask(
  f: World,
  fields: Partial<{
    title: string;
    active: boolean;
    asNeededMaxPerDay: number;
    asNeededMinHours: number;
    pillDescription: string;
  }> = {},
): Promise<Id<"tasks">> {
  return await f.t.run(
    async (ctx) =>
      await ctx.db.insert("tasks", {
        householdId: f.householdId,
        type: "medication",
        title: fields.title ?? "Task",
        displayLabel: fields.title ?? "Task",
        spokenPrompt: "Time.",
        checklistItems: [],
        times: [],
        windowMinutes: 60,
        createdByKind: "caregiver",
        active: fields.active ?? true,
        scheduleChangedAt: 0,
        asNeededMaxPerDay: fields.asNeededMaxPerDay,
        asNeededMinHours: fields.asNeededMinHours,
        pillDescription: fields.pillDescription,
      }),
  );
}

/**
 * purpose: Insert a due instance of a task on today's local date.
 * @param f: (Fixture) Fixture.
 * @param taskId: (Id<"tasks">) Task.
 * @return: (Promise<Id<"taskInstances">>) The instance.
 */
async function insertDueInstance(f: World, taskId: Id<"tasks">): Promise<Id<"taskInstances">> {
  return await f.t.run(
    async (ctx) =>
      await ctx.db.insert("taskInstances", {
        taskId,
        householdId: f.householdId,
        localDate: "2027-03-10",
        scheduledTime: "09:30",
        windowStart: NOW - HOUR / 2,
        windowEnd: NOW + HOUR / 2,
        state: "due",
        createdAt: NOW - HOUR,
        firedSteps: [],
      }),
  );
}

/**
 * purpose: Insert an event.
 * @param f: (Fixture) Fixture.
 * @param fields: (object) Event fields; startsOn and startTime are local.
 * @return: (Promise<Id<"events">>) The event.
 */
async function insertEvent(
  f: World,
  fields: {
    title: string;
    startsOn: string;
    startTime: string;
    durationMinutes?: number;
    label?: string;
    place?: string;
    repeatDays?: number[];
    deletedAt?: number;
  },
): Promise<Id<"events">> {
  return await f.t.run(
    async (ctx) =>
      await ctx.db.insert("events", {
        householdId: f.householdId,
        createdVia: "caregiver",
        ...fields,
      }),
  );
}

/** One agent function under test with valid arguments, for the access tests. */
interface AgentCall {
  name: string;
  kind: "query" | "mutation";
  run: (f: Fixture, extra: Record<string, unknown>) => Promise<unknown>;
}

/**
 * purpose: The nine agent entry points with valid arguments for a fixture.
 * @return: (AgentCall[]) The calls.
 */
function allCalls(): AgentCall[] {
  const q = (name: string, ref: unknown, args: (f: Fixture) => object): AgentCall => ({
    name,
    kind: "query",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (f, extra) => f.t.query(ref as any, { ...args(f), ...extra } as any),
  });
  const m = (name: string, ref: unknown, args: (f: Fixture) => object): AgentCall => ({
    name,
    kind: "mutation",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (f, extra) => f.t.mutation(ref as any, { ...args(f), ...extra } as any),
  });
  return [
    q("getContext", api.agent.getContext, (f) => ({ householdId: f.householdId, now: NOW })),
    q("today", api.agent.today, (f) => ({ householdId: f.householdId, now: NOW })),
    m("confirmDueTask", api.agent.confirmDueTask, (f) => ({ householdId: f.householdId })),
    m("createSeniorReminder", api.agent.createSeniorReminder, (f) => ({
      householdId: f.householdId,
      title: "Call Sam",
      time: "10:00",
      now: NOW,
    })),
    m("cancelSeniorReminder", api.agent.cancelSeniorReminder, (f) => ({
      householdId: f.householdId,
      query: "sam",
    })),
    m("startConversation", api.agent.startConversation, (f) => ({
      householdId: f.householdId,
      trigger: "talk",
    })),
    m("logTurn", api.agent.logTurn, (f) => ({
      conversationId: f.conversationId,
      role: "user",
      content: "hi",
    })),
    m("finishConversation", api.agent.finishConversation, (f) => ({
      conversationId: f.conversationId,
    })),
  ];
}

describe("agent key", () => {
  const FORBIDDEN = { data: { code: "forbidden", message: "Invalid agent key" } };

  test.each(allCalls().map((c) => [c.name, c] as const))(
    "%s rejects a wrong key",
    async (_name, call) => {
      const f = await setup();
      await expect(call.run(f, { agentKey: "wrong" })).rejects.toMatchObject(FORBIDDEN);
    },
  );

  test.each(allCalls().map((c) => [c.name, c] as const))(
    "%s rejects an empty key",
    async (_name, call) => {
      const f = await setup();
      await expect(call.run(f, { agentKey: "" })).rejects.toMatchObject(FORBIDDEN);
    },
  );

  test.each(allCalls().map((c) => [c.name, c] as const))(
    "%s rejects a missing key",
    async (_name, call) => {
      const f = await setup();
      await expect(call.run(f, {})).rejects.toThrow();
    },
  );

  test.each(allCalls().map((c) => [c.name, c] as const))(
    "%s rejects every key when SUNNY_AGENT_KEY is unset",
    async (_name, call) => {
      const f = await setup();
      delete process.env.SUNNY_AGENT_KEY;
      await expect(call.run(f, { agentKey: KEY })).rejects.toMatchObject(FORBIDDEN);
      await expect(call.run(f, { agentKey: "" })).rejects.toMatchObject(FORBIDDEN);
    },
  );

  test("a key that is a prefix or an extension of the real one is rejected", async () => {
    const f = await setup();
    const call = allCalls()[1]!;
    await expect(call.run(f, { agentKey: KEY.slice(0, -1) })).rejects.toMatchObject(FORBIDDEN);
    await expect(call.run(f, { agentKey: `${KEY}x` })).rejects.toMatchObject(FORBIDDEN);
  });

  test("a signed-in caregiver without the key is still rejected", async () => {
    const f = await setup();
    await expect(
      f.t
        .withIdentity({ subject: "user_a" })
        .query(api.agent.today, { agentKey: "nope", householdId: f.householdId }),
    ).rejects.toMatchObject(FORBIDDEN);
  });
});

describe("getContext", () => {
  test("has the exact shape for an empty household", async () => {
    const f = await setup();
    const context = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(context).toEqual({
      household: {
        id: f.householdId,
        seniorPreferredName: "Margaret",
        timezone: "America/New_York",
        localNow: "2027-03-10T10:00:00",
      },
      today: [],
      asNeeded: [],
      events: [],
      latestMessage: null,
      lifeProfile: [],
      sensitiveTopics: [],
      memory: [],
      recentConversations: [],
    });
  });

  test("an unknown household is not_found", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.delete(f.householdId));
    await expect(
      f.t.query(api.agent.getContext, { agentKey: KEY, householdId: f.householdId }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("today lists the schedule in the TodayEntry shape", async () => {
    const f = await setup();
    const taskId = await insertTask(f, { title: "Morning pills", pillDescription: "white pill" });
    const instanceId = await insertDueInstance(f, taskId);
    const context = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(context.today).toEqual([
      {
        instanceId,
        taskId,
        type: "medication",
        displayLabel: "Morning pills",
        spokenPrompt: "Time.",
        pillDescription: "white pill",
        checklistItems: [],
        scheduledTime: "09:30",
        state: "due",
        confirmedAt: null,
        confirmedVia: null,
      },
    ]);
    expect(
      await f.t.query(api.agent.today, { agentKey: KEY, householdId: f.householdId, now: NOW }),
    ).toEqual(context.today);
  });

  test("as-needed lists active as-needed tasks with doses since local midnight", async () => {
    const f = await setup();
    const aspirin = await insertTask(f, {
      title: "Aspirin",
      asNeededMaxPerDay: 3,
      asNeededMinHours: 4,
      pillDescription: "round",
    });
    const onlyMax = await insertTask(f, { title: "Tylenol", asNeededMaxPerDay: 2 });
    await insertTask(f, { title: "Scheduled" });
    await insertTask(f, { title: "Retired", asNeededMaxPerDay: 1, active: false });
    const dose = async (taskId: Id<"tasks">, takenAt: number) =>
      await f.t.run(
        async (ctx) =>
          await ctx.db.insert("doseLog", {
            householdId: f.householdId,
            taskId,
            takenAt,
            reportedVia: "voice",
          }),
      );
    await dose(aspirin, MIDNIGHT - 1);
    await dose(aspirin, MIDNIGHT + 3 * HOUR);
    await dose(aspirin, MIDNIGHT);
    await dose(onlyMax, MIDNIGHT + HOUR);

    const { asNeeded } = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });

    expect(asNeeded).toEqual([
      {
        taskId: aspirin,
        displayLabel: "Aspirin",
        pillDescription: "round",
        maxPerDay: 3,
        minHoursBetween: 4,
        takenToday: [MIDNIGHT, MIDNIGHT + 3 * HOUR],
      },
      {
        taskId: onlyMax,
        displayLabel: "Tylenol",
        pillDescription: null,
        maxPerDay: 2,
        minHoursBetween: null,
        takenToday: [MIDNIGHT + HOUR],
      },
    ]);
  });

  test("events cover the next 7 days and drop those that have ended or are cancelled", async () => {
    const f = await setup();
    // Local 2027-03-10: ended 09:30, ongoing 09:30-10:30, later today.
    await insertEvent(f, {
      title: "Ended",
      startsOn: "2027-03-10",
      startTime: "09:00",
      durationMinutes: 30,
    });
    await insertEvent(f, {
      title: "Ongoing",
      startsOn: "2027-03-10",
      startTime: "09:30",
      durationMinutes: 60,
      place: "Clinic",
    });
    await insertEvent(f, { title: "No end, past", startsOn: "2027-03-10", startTime: "08:00" });
    await insertEvent(f, {
      title: "Dentist",
      label: "Teeth check",
      startsOn: "2027-03-11",
      startTime: "14:00",
    });
    // Exactly 7 days ahead: 09:00 is inside the window (14:00Z < 15:00Z), 11:00 is outside.
    await insertEvent(f, { title: "Edge in", startsOn: "2027-03-17", startTime: "09:00" });
    await insertEvent(f, { title: "Edge out", startsOn: "2027-03-17", startTime: "11:00" });
    await insertEvent(f, {
      title: "Cancelled",
      startsOn: "2027-03-12",
      startTime: "10:00",
      deletedAt: NOW,
    });
    await insertEvent(f, {
      title: "Weekly yoga",
      startsOn: "2027-03-01",
      startTime: "16:00",
      repeatDays: [5],
    });

    const { events } = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });

    expect(events.map((e) => e.title)).toEqual(["Ongoing", "Dentist", "Weekly yoga", "Edge in"]);
    expect(events[0]).toEqual({
      title: "Ongoing",
      label: "Ongoing",
      startsAt: Date.parse("2027-03-10T14:30:00Z"),
      endsAt: Date.parse("2027-03-10T15:30:00Z"),
      place: "Clinic",
      visitorName: null,
      notes: null,
    });
    expect(events[1]).toMatchObject({
      label: "Teeth check",
      startsAt: Date.parse("2027-03-11T19:00:00Z"),
      endsAt: null,
    });
    // 2027-03-12 is a Friday; 16:00 EST.
    expect(events[2]!.startsAt).toBe(Date.parse("2027-03-12T21:00:00Z"));
  });

  test("events use the DST offset of their own day", async () => {
    const f = await setup();
    // DST starts 2027-03-14 at 02:00; 09:00 that day is EDT (13:00Z).
    await insertEvent(f, { title: "After DST", startsOn: "2027-03-14", startTime: "09:00" });
    const { events } = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(events[0]!.startsAt).toBe(Date.parse("2027-03-14T13:00:00Z"));
  });

  test("latestMessage is the newest caregiver message with the sender's name", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("familyMessages", {
        householdId: f.householdId,
        senderKind: "caregiver",
        senderUserId: "user_a",
        body: "old",
      });
      await ctx.db.insert("familyMessages", {
        householdId: f.householdId,
        senderKind: "caregiver",
        senderUserId: "user_a",
        body: "Coming at 4",
        seenAt: NOW,
      });
      await ctx.db.insert("familyMessages", {
        householdId: f.householdId,
        senderKind: "senior",
        body: "from Margaret",
      });
    });
    const { latestMessage } = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(latestMessage).toMatchObject({
      from: "Anna",
      body: "Coming at 4",
      hasPhoto: false,
      seen: true,
    });
    expect(typeof latestMessage!.sentAt).toBe("number");
  });

  test("latestMessage falls back to family and reports photos and unseen", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      const photo = await ctx.storage.store(new Blob(["x"]));
      await ctx.db.insert("familyMessages", {
        householdId: f.householdId,
        senderKind: "caregiver",
        senderUserId: "gone_user",
        photoStorageId: photo,
      });
    });
    const { latestMessage } = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(latestMessage).toMatchObject({
      from: "family",
      body: null,
      hasPhoto: true,
      seen: false,
    });
  });

  test("life profile is ordered by category then name; sensitive topics keep order", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      const entry = (category: "person" | "place" | "doctor" | "other", name: string) =>
        ctx.db.insert("lifeProfileEntries", {
          householdId: f.householdId,
          category,
          name,
          details: name === "Zed" ? undefined : `about ${name}`,
        });
      await entry("other", "Misc");
      await entry("doctor", "Dr. Lee");
      await entry("person", "Zed");
      await entry("person", "Alice");
      await entry("place", "Home");
      await ctx.db.insert("sensitiveTopics", {
        householdId: f.householdId,
        topic: "Husband",
        guidance: "Change the subject gently",
      });
      await ctx.db.insert("sensitiveTopics", {
        householdId: f.householdId,
        topic: "Car",
        guidance: "Say it is at the garage",
      });
    });
    const context = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(context.lifeProfile.map((l) => l.name)).toEqual([
      "Alice",
      "Zed",
      "Home",
      "Dr. Lee",
      "Misc",
    ]);
    expect(context.lifeProfile[1]).toEqual({ category: "person", name: "Zed", details: null });
    expect(context.sensitiveTopics).toEqual([
      { topic: "Husband", guidance: "Change the subject gently" },
      { topic: "Car", guidance: "Say it is at the garage" },
    ]);
  });

  test("memory is verified first, then newest first, capped at 50", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("agentMemory", {
          householdId: f.householdId,
          fact: `fact ${i}`,
          source: "senior",
          // Facts 3 and 1 are verified.
          verifiedAt: i === 1 || i === 3 ? NOW : undefined,
          verifiedBy: i === 1 || i === 3 ? "user_a" : undefined,
        });
      }
    });
    const { memory } = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(memory).toHaveLength(50);
    expect(memory.slice(0, 2).map((m) => [m.fact, m.verified])).toEqual([
      ["fact 3", true],
      ["fact 1", true],
    ]);
    expect(memory[2]).toMatchObject({ fact: "fact 54", source: "senior", verified: false });
    expect(memory[3]!.fact).toBe("fact 53");
    expect(typeof memory[0]!.notedAt).toBe("number");
    // 55 facts, 2 verified: the 48 newest unverified ones (7..54) fit; the older ones drop.
    expect(memory.map((m) => m.fact)).not.toContain("fact 0");
    expect(memory.map((m) => m.fact)).not.toContain("fact 6");
    expect(memory.map((m) => m.fact)).toContain("fact 7");
  });

  test("recentConversations are the five newest with a summary", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 7; i++) {
        await ctx.db.insert("conversations", {
          householdId: f.householdId,
          trigger: "talk",
          startedAt: NOW - (7 - i) * HOUR,
          summary: i === 6 ? undefined : `summary ${i}`,
        });
      }
    });
    const { recentConversations } = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(recentConversations.map((c) => c.summary)).toEqual([
      "summary 5",
      "summary 4",
      "summary 3",
      "summary 2",
      "summary 1",
    ]);
    expect(recentConversations[0]!.startedAt).toBe(NOW - 2 * HOUR);
  });

  test("other households' data is not included", async () => {
    const f = await setup();
    const other = await f.t.run(async (ctx) => {
      const id = await ctx.db.insert("households", {
        seniorPreferredName: "Other",
        timezone: "America/New_York",
        digestTime: "19:00",
        eventNoticeTime: "08:00",
        shareTranscripts: false,
        backgroundPaused: false,
      });
      await ctx.db.insert("agentMemory", { householdId: id, fact: "secret", source: "senior" });
      return id;
    });
    const context = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(context.memory).toEqual([]);
    const otherContext = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: other,
      now: NOW,
    });
    expect(otherContext.memory).toHaveLength(1);
  });
});

describe("confirmDueTask", () => {
  test("confirms the due task by voice", async () => {
    const f = await setup();
    const taskId = await insertTask(f, { title: "Morning pills" });
    const instanceId = await insertDueInstance(f, taskId);

    const result = await f.t.mutation(api.agent.confirmDueTask, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "confirmed",
      instanceId,
      displayLabel: "Morning pills",
      state: "confirmed",
      confirmedAt: NOW,
    });
    const row = await f.t.run(async (ctx) => await ctx.db.get(instanceId));
    expect(row).toMatchObject({ state: "confirmed", confirmedVia: "voice", confirmedAt: NOW });
    expect(row!.confirmedBy).toBeUndefined();
  });

  test("a label picks the matching task and null means no label", async () => {
    const f = await setup();
    const pills = await insertTask(f, { title: "Morning pills" });
    const walk = await insertTask(f, { title: "Walk" });
    await insertDueInstance(f, pills);
    const walkInstance = await insertDueInstance(f, walk);

    const ambiguous = await f.t.mutation(api.agent.confirmDueTask, {
      agentKey: KEY,
      householdId: f.householdId,
      label: null,
      now: NOW,
    });
    expect(ambiguous.status).toBe("confirmed");

    const labelled = await f.t.mutation(api.agent.confirmDueTask, {
      agentKey: KEY,
      householdId: f.householdId,
      label: "walk",
      now: NOW,
    });
    expect(labelled).toMatchObject({ status: "confirmed", instanceId: walkInstance });
  });
});

describe("reminders", () => {
  test("createSeniorReminder returns the task id and creates a senior reminder", async () => {
    const f = await setup();
    const { taskId } = await f.t.mutation(api.agent.createSeniorReminder, {
      agentKey: KEY,
      householdId: f.householdId,
      title: "call the plumber",
      time: "10:00",
      onDate: "2027-03-11",
      days: null,
      now: NOW,
    });
    const task = await f.t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task).toMatchObject({
      type: "reminder",
      title: "call the plumber",
      displayLabel: "Call the plumber",
      createdByKind: "senior",
      onceOn: "2027-03-11",
      times: ["10:00"],
      active: true,
    });
  });

  test("recurring days are honored and null date means recurring", async () => {
    const f = await setup();
    const { taskId } = await f.t.mutation(api.agent.createSeniorReminder, {
      agentKey: KEY,
      householdId: f.householdId,
      title: "water plants",
      time: "09:00",
      onDate: null,
      days: [1, 3],
      now: NOW,
    });
    const task = await f.t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task!.onceOn).toBeUndefined();
    expect(task!.daysOfWeek).toEqual([1, 3]);
  });

  test("cancelSeniorReminder cancels, reports not_found and ambiguous", async () => {
    const f = await setup();
    const create = (title: string) =>
      f.t.mutation(api.agent.createSeniorReminder, {
        agentKey: KEY,
        householdId: f.householdId,
        title,
        time: "10:00",
        now: NOW,
      });
    const { taskId } = await create("call the plumber");
    await create("call Sam");
    const cancel = (query: string) =>
      f.t.mutation(api.agent.cancelSeniorReminder, {
        agentKey: KEY,
        householdId: f.householdId,
        query,
      });

    expect(await cancel("call")).toEqual({
      status: "ambiguous",
      titles: ["call the plumber", "call Sam"],
    });
    expect(await cancel("dentist")).toEqual({ status: "not_found", titles: [] });
    expect(await cancel("plumber")).toEqual({
      status: "cancelled",
      titles: ["call the plumber"],
    });
    expect((await f.t.run(async (ctx) => await ctx.db.get(taskId)))!.active).toBe(false);
  });
});

describe("conversation logging", () => {
  /**
   * purpose: Insert a device and a due instance for a household.
   * @param f: (World) Harness and household.
   * @return: (Promise<{deviceId, instanceId}>) The ids.
   */
  async function deviceAndInstance(f: World) {
    const deviceId = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("devices", {
          householdId: f.householdId,
          userId: "phone",
          kind: "senior_phone",
        }),
    );
    const instanceId = await insertDueInstance(f, await insertTask(f));
    return { deviceId, instanceId };
  }

  test("start, log turns and finish a conversation", async () => {
    const f = await setup();
    const { deviceId, instanceId } = await deviceAndInstance(f);

    const conversationId = await f.t.mutation(api.agent.startConversation, {
      agentKey: KEY,
      householdId: f.householdId,
      deviceId,
      trigger: "scheduled_prompt",
      taskInstanceId: instanceId,
      now: NOW,
    });
    expect(await f.t.run(async (ctx) => await ctx.db.get(conversationId))).toMatchObject({
      householdId: f.householdId,
      deviceId,
      trigger: "scheduled_prompt",
      taskInstanceId: instanceId,
      startedAt: NOW,
    });

    for (const [role, content] of [
      ["assistant", "Time for your pills."],
      ["user", "Okay, done."],
    ] as const) {
      expect(
        await f.t.mutation(api.agent.logTurn, { agentKey: KEY, conversationId, role, content }),
      ).toBeNull();
    }
    const turns = await f.t.run(
      async (ctx) =>
        await ctx.db
          .query("conversationTurns")
          .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
          .collect(),
    );
    expect(turns.map((t) => [t.role, t.content])).toEqual([
      ["assistant", "Time for your pills."],
      ["user", "Okay, done."],
    ]);

    expect(
      await f.t.mutation(api.agent.finishConversation, {
        agentKey: KEY,
        conversationId,
        summary: "  Took pills.  ",
        now: NOW + HOUR,
      }),
    ).toBeNull();
    expect(await f.t.run(async (ctx) => await ctx.db.get(conversationId))).toMatchObject({
      endedAt: NOW + HOUR,
      summary: "Took pills.",
    });
  });

  test("null ids are allowed and finishing without a summary keeps it unset", async () => {
    const f = await setup();
    const conversationId = await f.t.mutation(api.agent.startConversation, {
      agentKey: KEY,
      householdId: f.householdId,
      deviceId: null,
      trigger: "talk",
      taskInstanceId: null,
      now: NOW,
    });
    for (const summary of [null, "  ", undefined]) {
      await f.t.mutation(api.agent.finishConversation, {
        agentKey: KEY,
        conversationId,
        summary,
        now: NOW + HOUR,
      });
    }
    const row = await f.t.run(async (ctx) => await ctx.db.get(conversationId));
    expect(row!.endedAt).toBe(NOW + HOUR);
    expect(row!.summary).toBeUndefined();
    expect(row!.deviceId).toBeUndefined();
  });

  test("finishing keeps an earlier summary when none is given", async () => {
    const f = await setup();
    const conversationId = await f.t.mutation(api.agent.startConversation, {
      agentKey: KEY,
      householdId: f.householdId,
      trigger: "talk",
      now: NOW,
    });
    await f.t.mutation(api.agent.finishConversation, {
      agentKey: KEY,
      conversationId,
      summary: "First",
      now: NOW,
    });
    await f.t.mutation(api.agent.finishConversation, { agentKey: KEY, conversationId, now: NOW });
    expect((await f.t.run(async (ctx) => await ctx.db.get(conversationId)))!.summary).toBe("First");
  });

  test("a device or instance of another household is rejected", async () => {
    const f = await setup();
    const otherId = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("households", {
          seniorPreferredName: "Other",
          timezone: "America/New_York",
          digestTime: "19:00",
          eventNoticeTime: "08:00",
          shareTranscripts: false,
          backgroundPaused: false,
        }),
    );
    const foreign = await deviceAndInstance({ t: f.t, householdId: otherId });
    await expect(
      f.t.mutation(api.agent.startConversation, {
        agentKey: KEY,
        householdId: f.householdId,
        deviceId: foreign.deviceId,
        trigger: "talk",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found", message: "Device not found" } });
    await expect(
      f.t.mutation(api.agent.startConversation, {
        agentKey: KEY,
        householdId: f.householdId,
        taskInstanceId: foreign.instanceId,
        trigger: "talk",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found", message: "Task instance not found" } });
  });

  test("a missing household, conversation, device or instance is not_found", async () => {
    const f = await setup();
    const { deviceId, instanceId } = await deviceAndInstance(f);
    await f.t.run(async (ctx) => {
      await ctx.db.delete(deviceId);
      await ctx.db.delete(instanceId);
    });
    await expect(
      f.t.mutation(api.agent.startConversation, {
        agentKey: KEY,
        householdId: f.householdId,
        deviceId,
        trigger: "talk",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found", message: "Device not found" } });
    await expect(
      f.t.mutation(api.agent.startConversation, {
        agentKey: KEY,
        householdId: f.householdId,
        taskInstanceId: instanceId,
        trigger: "talk",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found", message: "Task instance not found" } });

    const conversationId = await f.t.mutation(api.agent.startConversation, {
      agentKey: KEY,
      householdId: f.householdId,
      trigger: "talk",
    });
    await f.t.run(async (ctx) => await ctx.db.delete(conversationId));
    await expect(
      f.t.mutation(api.agent.logTurn, {
        agentKey: KEY,
        conversationId,
        role: "user",
        content: "hi",
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
    await expect(
      f.t.mutation(api.agent.finishConversation, { agentKey: KEY, conversationId }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("logTurn rejects a role other than user or assistant", async () => {
    const f = await setup();
    const conversationId = await f.t.mutation(api.agent.startConversation, {
      agentKey: KEY,
      householdId: f.householdId,
      trigger: "talk",
    });
    await expect(
      f.t.mutation(api.agent.logTurn, {
        agentKey: KEY,
        conversationId,
        // @ts-expect-error not a valid role
        role: "system",
        content: "hi",
      }),
    ).rejects.toThrow();
  });
});

describe("logTurn length cap and accepted trust model", () => {
  test("logTurn truncates content over the cap instead of rejecting it", async () => {
    const f = await setup();
    await f.t.mutation(api.agent.logTurn, {
      agentKey: KEY,
      conversationId: f.conversationId,
      role: "assistant",
      content: "x".repeat(MAX_TURN_CONTENT_LENGTH + 500),
    });
    const turns = await f.t.run(async (ctx) => await ctx.db.query("conversationTurns").collect());
    expect(turns).toHaveLength(1);
    expect(turns[0]!.content).toHaveLength(MAX_TURN_CONTENT_LENGTH);
  });

  test("logTurn keeps content at exactly the cap unchanged", async () => {
    const f = await setup();
    const content = "y".repeat(MAX_TURN_CONTENT_LENGTH);
    await f.t.mutation(api.agent.logTurn, {
      agentKey: KEY,
      conversationId: f.conversationId,
      role: "user",
      content,
    });
    const turns = await f.t.run(async (ctx) => await ctx.db.query("conversationTurns").collect());
    expect(turns[0]!.content).toBe(content);
  });

  test("today gives not_found for an unknown household", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.delete(f.householdId));
    await expect(
      f.t.query(api.agent.today, { agentKey: KEY, householdId: f.householdId, now: NOW }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("a valid key is the only gate: any conversation can be logged to and finished", async () => {
    const f = await setup();
    // A conversation belonging to a different household than the fixture's.
    const other = await f.t.withIdentity({ subject: "user_b" }).mutation(api.households.create, {
      seniorPreferredName: "Walter",
      timezone: "America/New_York",
      caregiverDisplayName: "Bea",
    });
    const foreign = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("conversations", {
          householdId: other,
          trigger: "talk",
          startedAt: NOW,
        }),
    );
    await f.t.mutation(api.agent.logTurn, {
      agentKey: KEY,
      conversationId: foreign,
      role: "user",
      content: "hello",
    });
    await f.t.mutation(api.agent.finishConversation, {
      agentKey: KEY,
      conversationId: foreign,
      summary: "A chat.",
      now: NOW,
    });
    expect(await f.t.run(async (ctx) => await ctx.db.get(foreign))).toMatchObject({
      endedAt: NOW,
      summary: "A chat.",
    });
  });
});
