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
// Voice tools (2026-11-09): the context's weather location, caregivers and recent question
// topics; medicationStatus; snoozeDueTask ("not yet"); logAsNeededDose (label limits, the
// caregiver flag past a limit, never a dose without a rule); rememberFact (unverified, never
// overwriting a verified fact); flagCaregiver (on-call first, all caregivers otherwise, repeat
// window, audit); sendFamilyMessage; readLatestMessage (seenAt); logQuestions and the digest
// facts that read those rows; and households.update's weatherLocation. Each is scoped to the
// household it is given. The system clock is frozen at NOW (the outbox enqueues delivery).
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { MAX_TURN_CONTENT_LENGTH } from "./agent";
import { gatherDigestFacts } from "./lib/digestFacts";
import {
  MAX_FACT_LENGTH,
  MAX_UNVERIFIED_SENIOR_FACTS,
  MEMORY_CONTEXT_LIMIT,
  MEMORY_UNVERIFIED_RESERVE,
} from "./lib/memoryLimits";
import { FLAG_REPEAT_WINDOW_MS, MAX_FLAG_DETAIL_LENGTH } from "./lib/voiceRouting";
import { addMember, makeBackend, setPhone } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

const KEY = "agent-secret-key";
/** Wednesday 2027-03-10 10:00 in New York (EST); local midnight is 05:00Z. */
const NOW = Date.parse("2027-03-10T15:00:00Z");
const MIDNIGHT = Date.parse("2027-03-10T05:00:00Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.SUNNY_AGENT_KEY;
  process.env.SUNNY_AGENT_KEY = KEY;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  if (savedKey === undefined) delete process.env.SUNNY_AGENT_KEY;
  else process.env.SUNNY_AGENT_KEY = savedKey;
});

/** A household created through the public API (so the default policies exist). */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  conversationId: Id<"conversations">;
}

/** The harness and household, which is all the insert helpers need. */
type World = Pick<Fixture, "t" | "householdId">;

/**
 * purpose: Create a household for Margaret in New York with caregiver Anna (user_a, on call,
 *          with a verified phone so she can be texted).
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(): Promise<Fixture> {
  const t = makeBackend();
  const householdId = await t.withIdentity({ subject: "user_a" }).mutation(api.households.create, {
    seniorPreferredName: "Margaret",
    timezone: "America/New_York",
    caregiverDisplayName: "Anna",
  });
  await setPhone(t, householdId, "user_a", "+15555550101");
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
 * purpose: Every agent entry point with valid arguments for a fixture.
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
    q("medicationStatus", api.agent.medicationStatus, (f) => ({ householdId: f.householdId })),
    m("snoozeDueTask", api.agent.snoozeDueTask, (f) => ({ householdId: f.householdId })),
    m("logAsNeededDose", api.agent.logAsNeededDose, (f) => ({ householdId: f.householdId })),
    m("rememberFact", api.agent.rememberFact, (f) => ({
      householdId: f.householdId,
      fact: "Glasses are in the hall drawer",
    })),
    m("flagCaregiver", api.agent.flagCaregiver, (f) => ({
      householdId: f.householdId,
      reason: "scam",
      detail: "A caller asked for gift cards",
    })),
    m("sendFamilyMessage", api.agent.sendFamilyMessage, (f) => ({
      householdId: f.householdId,
      body: "I'm home",
    })),
    m("readLatestMessage", api.agent.readLatestMessage, (f) => ({ householdId: f.householdId })),
    m("logQuestions", api.agent.logQuestions, (f) => ({
      conversationId: f.conversationId,
      questions: [],
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
        weatherLocation: null,
      },
      caregivers: [{ name: "Anna", onCall: true }],
      today: [],
      asNeeded: [],
      events: [],
      latestMessage: null,
      lifeProfile: [],
      sensitiveTopics: [],
      memory: [],
      recentConversations: [],
      recentQuestionTopics: [],
      list: { openCount: 0, items: [] },
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
        localDate: "2027-03-10",
        carriedOver: false,
        taskId,
        type: "medication",
        displayLabel: "Morning pills",
        spokenPrompt: "Time.",
        pillDescription: "white pill",
        checklistItems: [],
        scheduledTime: "09:30",
        state: "due",
        confirmedAt: null,
        confirmedLocalTime: null,
        confirmedVia: null,
        claimedBy: null,
        claimedByName: null,
        confirmedBy: null,
        confirmedByName: null,
        resolutionNote: null,
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
        // The dose just before midnight is within the trailing 24 hours: 3 of 3.
        takenLast24h: [MIDNIGHT - 1, MIDNIGHT, MIDNIGHT + 3 * HOUR],
        lastTakenAt: MIDNIGHT + 3 * HOUR,
        remainingToday: 0,
        nextWithinLabelAt: MIDNIGHT - 1 + 24 * HOUR,
        daysUsedLast7: 2,
      },
      {
        taskId: onlyMax,
        displayLabel: "Tylenol",
        pillDescription: null,
        maxPerDay: 2,
        minHoursBetween: null,
        takenToday: [MIDNIGHT + HOUR],
        takenLast24h: [MIDNIGHT + HOUR],
        lastTakenAt: MIDNIGHT + HOUR,
        remainingToday: 1,
        nextWithinLabelAt: null,
        daysUsedLast7: 1,
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

  test("memory keeps at least 10 unverified slots however many facts are verified", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 15; i++) {
        await ctx.db.insert("agentMemory", {
          householdId: f.householdId,
          fact: `said ${i}`,
          source: "senior",
        });
      }
      for (let i = 0; i < 45; i++) {
        await ctx.db.insert("agentMemory", {
          householdId: f.householdId,
          fact: `verified ${i}`,
          source: "caregiver",
          verifiedBy: "user_a",
          verifiedAt: NOW,
        });
      }
    });
    const { memory } = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(memory).toHaveLength(MEMORY_CONTEXT_LIMIT);
    const verified = memory.filter((m) => m.verified);
    expect(verified).toHaveLength(MEMORY_CONTEXT_LIMIT - MEMORY_UNVERIFIED_RESERVE);
    expect(verified[0]!.fact).toBe("verified 44");
    expect(memory.filter((m) => !m.verified).map((m) => m.fact)).toEqual(
      Array.from({ length: MEMORY_UNVERIFIED_RESERVE }, (_, i) => `said ${14 - i}`),
    );
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

// ---------------------------------------------------------------------------------------------
// Voice tools (2026-11-09)
// ---------------------------------------------------------------------------------------------

/**
 * purpose: Insert an instance of a task on today's local date in any state.
 * @param f: (World) Harness and household.
 * @param taskId: (Id<"tasks">) Task.
 * @param fields: (object) state (default due), scheduledTime (default "09:30"), confirmedAt.
 * @return: (Promise<Id<"taskInstances">>) The instance.
 */
async function insertInstance(
  f: World,
  taskId: Id<"tasks">,
  fields: Partial<Pick<Doc<"taskInstances">, "state" | "scheduledTime" | "confirmedAt">> = {},
): Promise<Id<"taskInstances">> {
  return await f.t.run(
    async (ctx) =>
      await ctx.db.insert("taskInstances", {
        taskId,
        householdId: f.householdId,
        localDate: "2027-03-10",
        scheduledTime: fields.scheduledTime ?? "09:30",
        windowStart: NOW - HOUR / 2,
        windowEnd: NOW + HOUR / 2,
        state: fields.state ?? "due",
        confirmedAt: fields.confirmedAt,
        createdAt: NOW - HOUR,
        firedSteps: [],
      }),
  );
}

/**
 * purpose: A second household (Walter, caregiver Bea as user_z), for scoping tests.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<Id<"households">>) The household.
 */
async function otherHousehold(t: TestConvex): Promise<Id<"households">> {
  return await t.withIdentity({ subject: "user_z" }).mutation(api.households.create, {
    seniorPreferredName: "Walter",
    timezone: "America/New_York",
    caregiverDisplayName: "Bea",
  });
}

/**
 * purpose: A conversation row in another household.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<Id<"conversations">>) The conversation.
 */
async function foreignConversation(t: TestConvex): Promise<Id<"conversations">> {
  const other = await otherHousehold(t);
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("conversations", { householdId: other, trigger: "talk", startedAt: NOW }),
  );
}

/**
 * purpose: Insert a dose row directly.
 * @param f: (World) Harness and household.
 * @param taskId: (Id<"tasks">) The as-needed task.
 * @param takenAt: (number) Epoch ms.
 * @return: (Promise<void>) Resolves when inserted.
 */
async function insertDose(f: World, taskId: Id<"tasks">, takenAt: number): Promise<void> {
  await f.t.run(async (ctx) => {
    await ctx.db.insert("doseLog", {
      householdId: f.householdId,
      taskId,
      takenAt,
      reportedVia: "button",
    });
  });
}

/**
 * purpose: The household's outbox rows of one kind, oldest first.
 * @param f: (World) Harness and household.
 * @param kind: (Doc<"notificationOutbox">["kind"]) The kind.
 * @return: (Promise<Doc<"notificationOutbox">[]>) Rows.
 */
async function outbox(
  f: World,
  kind: Doc<"notificationOutbox">["kind"],
): Promise<Doc<"notificationOutbox">[]> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("notificationOutbox").collect());
  return rows.filter((r) => r.kind === kind && r.householdId === f.householdId);
}

/**
 * purpose: The household's audit rows with one action.
 * @param f: (World) Harness and household.
 * @param action: (string) The action.
 * @return: (Promise<Doc<"auditLog">[]>) Rows.
 */
async function auditRows(f: World, action: string): Promise<Doc<"auditLog">[]> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
  return rows.filter((r) => r.action === action && r.householdId === f.householdId);
}

/**
 * purpose: Add Bob (member, user_b) and Sarah Lee (member, user_c) to the household, both
 *          with verified phones.
 * @param f: (World) Harness and household.
 * @return: (Promise<void>) Resolves when added.
 */
async function addFamily(f: World): Promise<void> {
  await addMember(f.t, f.householdId, "user_b", "member", "Bob");
  await addMember(f.t, f.householdId, "user_c", "member", "Sarah Lee");
  await setPhone(f.t, f.householdId, "user_b", "+15555550102");
  await setPhone(f.t, f.householdId, "user_c", "+15555550103");
}

/**
 * purpose: A question row argument for logQuestions.
 * @param question: (string) The question.
 * @param topic: (string) Its topic.
 * @param extra: (object) outcome (default answered), toolsUsed (default none), askedAt.
 * @return: (object) The argument.
 */
function asked(
  question: string,
  topic: string,
  extra: Partial<{
    outcome: "answered" | "routed" | "unsure";
    toolsUsed: string[];
    askedAt: number;
  }> = {},
) {
  return { question, topic, outcome: "answered" as const, toolsUsed: [], ...extra };
}

describe("context additions", () => {
  test("weatherLocation is set, trimmed and cleared through households.update", async () => {
    const f = await setup();
    const anna = f.t.withIdentity({ subject: "user_a" });
    /**
     * purpose: The weather location getContext reports.
     * @return: (Promise<string | null>) The location.
     */
    const read = async (): Promise<string | null> =>
      (
        await f.t.query(api.agent.getContext, {
          agentKey: KEY,
          householdId: f.householdId,
          now: NOW,
        })
      ).household.weatherLocation;

    await anna.mutation(api.households.update, {
      householdId: f.householdId,
      weatherLocation: "  Brooklyn, NY ",
    });
    expect(await read()).toBe("Brooklyn, NY");
    await anna.mutation(api.households.update, { householdId: f.householdId, weatherLocation: "" });
    expect(await read()).toBeNull();
    await expect(
      anna.mutation(api.households.update, {
        householdId: f.householdId,
        weatherLocation: "x".repeat(101),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("caregivers name the on-call one; recent topics are distinct, newest first", async () => {
    const f = await setup();
    await addFamily(f);
    // A long conversation, so its questions can span the last 8 days.
    await f.t.run(
      async (ctx) => await ctx.db.patch(f.conversationId, { startedAt: NOW - 9 * 24 * HOUR }),
    );
    await f.t.mutation(api.agent.logQuestions, {
      agentKey: KEY,
      conversationId: f.conversationId,
      questions: [
        asked("When is Sarah coming?", "Sarah visit", { askedAt: NOW - 2 * HOUR }),
        asked("Is it raining?", "weather", { askedAt: NOW - HOUR }),
        asked("When does Sarah come?", "sarah visit", { askedAt: NOW - 30 * MINUTE }),
        asked("Old one", "old", { askedAt: NOW - 8 * 24 * HOUR }),
      ],
    });
    const context = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(context.caregivers).toEqual(
      expect.arrayContaining([
        { name: "Anna", onCall: true },
        { name: "Bob", onCall: false },
        { name: "Sarah Lee", onCall: false },
      ]),
    );
    expect(context.recentQuestionTopics).toEqual(["sarah visit", "weather"]);
  });
});

describe("medicationStatus", () => {
  test("returns today's scheduled medications and the as-needed facts, fresh", async () => {
    const f = await setup();
    const morning = await insertTask(f, { title: "Morning pills" });
    await insertInstance(f, morning, {
      state: "confirmed",
      scheduledTime: "08:00",
      confirmedAt: NOW - 110 * MINUTE,
    });
    const walk = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("tasks", {
          householdId: f.householdId,
          type: "routine",
          title: "Walk",
          displayLabel: "Walk",
          spokenPrompt: "Walk.",
          checklistItems: [],
          times: ["14:00"],
          windowMinutes: 60,
          createdByKind: "caregiver",
          active: true,
          scheduleChangedAt: 0,
        }),
    );
    await insertInstance(f, walk, { state: "upcoming", scheduledTime: "14:00" });
    const relief = await insertTask(f, {
      title: "Pain reliever",
      asNeededMaxPerDay: 3,
      asNeededMinHours: 6,
    });
    // 11:00 PM yesterday and 9:00 AM today.
    await insertDose(f, relief, MIDNIGHT - HOUR);
    await insertDose(f, relief, NOW - HOUR);

    const status = await f.t.query(api.agent.medicationStatus, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(status.scheduled.map((e) => e.displayLabel)).toEqual(["Morning pills"]);
    expect(status.scheduled[0]).toMatchObject({ state: "confirmed", confirmedLocalTime: "08:10" });
    expect(status.asNeeded).toEqual([
      expect.objectContaining({
        displayLabel: "Pain reliever",
        takenToday: [NOW - HOUR],
        takenLast24h: [MIDNIGHT - HOUR, NOW - HOUR],
        lastTakenAt: NOW - HOUR,
        // Two in the trailing 24 hours count against the 3, though only one is today.
        remainingToday: 1,
        nextWithinLabelAt: NOW + 5 * HOUR,
        daysUsedLast7: 2,
      }),
    ]);
  });
});

describe("snoozeDueTask", () => {
  test("'not yet' snoozes the due task 15 minutes and audits it", async () => {
    const f = await setup();
    const pills = await insertTask(f, { title: "Morning pills" });
    const instanceId = await insertInstance(f, pills);

    const result = await f.t.mutation(api.agent.snoozeDueTask, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(result).toEqual({
      status: "snoozed",
      displayLabel: "Morning pills",
      scheduledTime: "09:30",
      snoozedUntil: NOW + 15 * MINUTE,
      confirmedAt: null,
      options: [],
    });
    const row = await f.t.run(async (ctx) => await ctx.db.get(instanceId));
    expect(row!.snoozedUntil).toBe(NOW + 15 * MINUTE);
    const audits = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(audits.some((a) => a.entityId === instanceId && a.actorKind === "agent")).toBe(true);
  });

  test("nothing due, unknown label, already done, not due yet and ambiguous", async () => {
    const f = await setup();
    /**
     * purpose: Snooze with an optional label.
     * @param label: (string, optional) Label words.
     * @return: (Promise<object>) The result.
     */
    const call = (label?: string) =>
      f.t.mutation(api.agent.snoozeDueTask, {
        agentKey: KEY,
        householdId: f.householdId,
        label: label ?? null,
        now: NOW,
      });
    expect((await call()).status).toBe("nothing_due");
    const pills = await insertTask(f, { title: "Morning pills" });
    await insertInstance(f, pills, { state: "confirmed", confirmedAt: NOW - 50 * MINUTE });
    expect(await call("morning")).toMatchObject({
      status: "already_done",
      confirmedAt: NOW - 50 * MINUTE,
    });
    expect((await call("garden")).status).toBe("not_found");
    const lunch = await insertTask(f, { title: "Lunch pills" });
    await insertInstance(f, lunch, { state: "upcoming", scheduledTime: "12:00" });
    expect(await call("lunch")).toMatchObject({ status: "not_due_yet", scheduledTime: "12:00" });
    const left = await insertTask(f, { title: "Eye drops left" });
    const right = await insertTask(f, { title: "Eye drops right" });
    await insertInstance(f, left);
    await insertInstance(f, right);
    expect(await call("eye drops")).toMatchObject({
      status: "ambiguous",
      options: ["Eye drops left", "Eye drops right"],
    });
  });

  test("another household's due task is never snoozed", async () => {
    const f = await setup();
    const other = { t: f.t, householdId: await otherHousehold(f.t) };
    const instanceId = await insertInstance(other, await insertTask(other, { title: "Pills" }));
    const result = await f.t.mutation(api.agent.snoozeDueTask, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(result.status).toBe("nothing_due");
    const row = await f.t.run(async (ctx) => await ctx.db.get(instanceId));
    expect(row!.snoozedUntil).toBeUndefined();
  });
});

describe("logAsNeededDose", () => {
  test("logs a voice dose and returns the label facts without flagging", async () => {
    const f = await setup();
    const relief = await insertTask(f, {
      title: "Pain reliever",
      asNeededMaxPerDay: 3,
      asNeededMinHours: 6,
    });
    await insertDose(f, relief, MIDNIGHT + HOUR);

    const result = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      label: "pain",
      minutesAgo: 10,
      conversationId: f.conversationId,
      now: NOW,
    });
    expect(result).toMatchObject({
      status: "logged",
      takenAt: NOW - 10 * MINUTE,
      overDailyMax: false,
      tooSoon: false,
      flagged: [],
      medication: {
        takenToday: [MIDNIGHT + HOUR, NOW - 10 * MINUTE],
        remainingToday: 1,
        nextWithinLabelAt: NOW - 10 * MINUTE + 6 * HOUR,
      },
    });
    const doses = await f.t.run(async (ctx) => await ctx.db.query("doseLog").collect());
    expect(doses.at(-1)).toMatchObject({ takenAt: NOW - 10 * MINUTE, reportedVia: "voice" });
    expect(await outbox(f, "agent_flag")).toEqual([]);
  });

  test("a dose past the daily maximum flags the on-call caregiver", async () => {
    const f = await setup();
    await addFamily(f);
    const relief = await insertTask(f, { title: "Pain reliever", asNeededMaxPerDay: 2 });
    await insertDose(f, relief, MIDNIGHT + HOUR);
    await insertDose(f, relief, MIDNIGHT + 2 * HOUR);

    const result = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(result).toMatchObject({
      status: "logged",
      overDailyMax: true,
      tooSoon: false,
      flagged: ["Anna"],
    });
    const flags = await outbox(f, "agent_flag");
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      recipientUserId: "user_a",
      state: "pending",
      title: "Margaret went past a medication limit",
      body:
        "Margaret reported taking Pain reliever at 10:00 AM. That is 3 in 24 hours, over the " +
        "label's 2 in 24 hours.",
      payload: { reason: "medication_limit" },
    });
    expect(await auditRows(f, "flag_caregiver")).toHaveLength(1);
  });

  test("a dose too soon after the last one, even across midnight, flags too", async () => {
    const f = await setup();
    const relief = await insertTask(f, { title: "Pain reliever", asNeededMinHours: 12 });
    await insertDose(f, relief, MIDNIGHT - HOUR);
    const result = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(result).toMatchObject({ overDailyMax: false, tooSoon: true, flagged: ["Anna"] });
  });

  test("a dose past both limits still reaches the caregiver as two sentences", async () => {
    const f = await setup();
    const relief = await insertTask(f, {
      title: "Pain reliever with a long caregiver label that keeps going",
      asNeededMaxPerDay: 1,
      asNeededMinHours: 6,
    });
    await insertDose(f, relief, NOW - HOUR);
    const result = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(result).toMatchObject({ overDailyMax: true, tooSoon: true });
    const [flag] = await outbox(f, "agent_flag");
    expect(flag!.body).toBe(
      "Margaret reported taking Pain reliever with a long caregiver label that keeps going at " +
        "10:00 AM. That is 2 in 24 hours, over the label's 1 in 24 hours, and less than the " +
        "label's 6 " +
        "hours from another dose.",
    );
    expect(flag!.body.length).toBeLessThanOrEqual(MAX_FLAG_DETAIL_LENGTH);
  });

  test("never logs without a matching as-needed rule", async () => {
    const f = await setup();
    /**
     * purpose: Log a dose by label.
     * @param label: (string | null) Label words.
     * @return: (Promise<object>) The result.
     */
    const call = (label: string | null) =>
      f.t.mutation(api.agent.logAsNeededDose, {
        agentKey: KEY,
        householdId: f.householdId,
        label,
        now: NOW,
      });
    await insertTask(f, { title: "Morning pills" });
    expect(await call("tylenol")).toEqual({ status: "no_rule", options: [] });
    await insertTask(f, { title: "Tylenol", asNeededMaxPerDay: 3 });
    await insertTask(f, { title: "Antacid", asNeededMaxPerDay: 2 });
    expect(await call("aspirin")).toEqual({ status: "not_found", options: ["Tylenol", "Antacid"] });
    expect(await call(null)).toEqual({ status: "ambiguous", options: ["Tylenol", "Antacid"] });
    expect(await f.t.run(async (ctx) => await ctx.db.query("doseLog").collect())).toEqual([]);
  });

  test("matches the caregiver title and pill description; rejects a bad minutesAgo", async () => {
    const f = await setup();
    const relief = await insertTask(f, {
      title: "Relief",
      asNeededMaxPerDay: 3,
      pillDescription: "small white Tylenol",
    });
    await f.t.run(async (ctx) => await ctx.db.patch(relief, { displayLabel: "Headache pill" }));
    const logged = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      label: "tylenol",
      now: NOW,
    });
    expect(logged).toMatchObject({
      status: "logged",
      medication: { displayLabel: "Headache pill" },
    });
    for (const minutesAgo of [-1, 1.5, 721]) {
      await expect(
        f.t.mutation(api.agent.logAsNeededDose, {
          agentKey: KEY,
          householdId: f.householdId,
          minutesAgo,
          now: NOW,
        }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
  });

  test("a conversation of another household is rejected", async () => {
    const f = await setup();
    const foreign = await foreignConversation(f.t);
    await insertTask(f, { title: "Tylenol", asNeededMaxPerDay: 3 });
    await expect(
      f.t.mutation(api.agent.logAsNeededDose, {
        agentKey: KEY,
        householdId: f.householdId,
        conversationId: foreign,
        now: NOW,
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});

describe("rememberFact", () => {
  test("stores an unverified senior fact linked to the conversation", async () => {
    const f = await setup();
    const result = await f.t.mutation(api.agent.rememberFact, {
      agentKey: KEY,
      householdId: f.householdId,
      fact: "  My glasses are in the hall drawer ",
      conversationId: f.conversationId,
    });
    expect(result).toEqual({ status: "saved" });
    const rows = await f.t.run(async (ctx) => await ctx.db.query("agentMemory").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      householdId: f.householdId,
      fact: "My glasses are in the hall drawer",
      source: "senior",
      conversationId: f.conversationId,
    });
    expect(rows[0]!.verifiedAt).toBeUndefined();
    expect(rows[0]!.verifiedBy).toBeUndefined();
    expect(await auditRows(f, "remember")).toHaveLength(1);
  });

  test("never overwrites or edits a verified fact, even a conflicting one", async () => {
    const f = await setup();
    const verified = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("agentMemory", {
          householdId: f.householdId,
          fact: "Sarah visits on Saturdays",
          source: "caregiver",
          verifiedBy: "user_a",
          verifiedAt: NOW - HOUR,
        }),
    );
    const before = await f.t.run(async (ctx) => await ctx.db.get(verified));
    /**
     * purpose: Remember a fact.
     * @param fact: (string) The fact.
     * @return: (Promise<object>) The result.
     */
    const remember = (fact: string) =>
      f.t.mutation(api.agent.rememberFact, { agentKey: KEY, householdId: f.householdId, fact });
    expect(await remember("Sarah visits on Sundays")).toEqual({ status: "saved" });
    expect(await remember("sarah visits on saturdays")).toEqual({ status: "already_known" });
    expect(await f.t.run(async (ctx) => await ctx.db.get(verified))).toEqual(before);
    const rows = await f.t.run(async (ctx) => await ctx.db.query("agentMemory").collect());
    expect(rows.map((r) => [r.fact, r.source, r.verifiedAt !== undefined])).toEqual([
      ["Sarah visits on Saturdays", "caregiver", true],
      ["Sarah visits on Sundays", "senior", false],
    ]);
  });

  test("a blank fact is invalid; another household's conversation is not_found", async () => {
    const f = await setup();
    /**
     * purpose: Remember a fact in an optional conversation.
     * @param fact: (string) The fact.
     * @param conversationId: (Id<"conversations">, optional) The conversation.
     * @return: (Promise<object>) The result.
     */
    const call = (fact: string, conversationId?: Id<"conversations">) =>
      f.t.mutation(api.agent.rememberFact, {
        agentKey: KEY,
        householdId: f.householdId,
        fact,
        conversationId,
      });
    await expect(call(" \n ")).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      call("Keys are on the hook", await foreignConversation(f.t)),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
    expect(await f.t.run(async (ctx) => await ctx.db.query("agentMemory").collect())).toEqual([]);
  });

  test("stores one line capped at 300 and skips a duplicate differing in case or spacing", async () => {
    const f = await setup();
    /**
     * purpose: Remember a fact.
     * @param fact: (string) The fact.
     * @return: (Promise<object>) The result.
     */
    const remember = (fact: string) =>
      f.t.mutation(api.agent.rememberFact, { agentKey: KEY, householdId: f.householdId, fact });
    expect(await remember("  Keys are\n\n on the   hook ")).toEqual({ status: "saved" });
    expect(await remember("KEYS are on the hook")).toEqual({ status: "already_known" });
    expect(await remember("y".repeat(400))).toEqual({ status: "saved" });
    const facts = (await f.t.run(async (ctx) => await ctx.db.query("agentMemory").collect())).map(
      (r) => r.fact,
    );
    expect(facts).toEqual(["Keys are on the hook", "y".repeat(MAX_FACT_LENGTH)]);
  });

  test("keeps the newest 200 unverified senior facts and never trims verified or family rows", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("agentMemory", {
        householdId: f.householdId,
        fact: "verified old",
        source: "caregiver",
        verifiedBy: "user_a",
        verifiedAt: NOW,
      });
      await ctx.db.insert("agentMemory", {
        householdId: f.householdId,
        fact: "family unverified old",
        source: "caregiver",
      });
      for (let i = 0; i < MAX_UNVERIFIED_SENIOR_FACTS; i++) {
        await ctx.db.insert("agentMemory", {
          householdId: f.householdId,
          fact: `senior ${i}`,
          source: "senior",
        });
      }
    });
    await f.t.mutation(api.agent.rememberFact, {
      agentKey: KEY,
      householdId: f.householdId,
      fact: "senior newest",
    });
    const rows = await f.t.run(async (ctx) => await ctx.db.query("agentMemory").collect());
    const senior = rows.filter((r) => r.source === "senior");
    expect(senior).toHaveLength(MAX_UNVERIFIED_SENIOR_FACTS);
    expect(senior.map((r) => r.fact)).not.toContain("senior 0");
    expect(senior.map((r) => r.fact)).toContain("senior 1");
    expect(senior.map((r) => r.fact)).toContain("senior newest");
    expect(rows.map((r) => r.fact)).toEqual(
      expect.arrayContaining(["verified old", "family unverified old"]),
    );
    const trims = await auditRows(f, "trim");
    expect(trims.map((a) => a.detail.fact)).toEqual(["senior 0"]);
  });
});

describe("flagCaregiver", () => {
  test("reaches the on-call caregiver only and audits the flag", async () => {
    const f = await setup();
    await addFamily(f);
    const result = await f.t.mutation(api.agent.flagCaregiver, {
      agentKey: KEY,
      householdId: f.householdId,
      reason: "scam",
      detail: "A caller said her grandson is in jail and asked for gift cards.",
      conversationId: f.conversationId,
      now: NOW,
    });
    expect(result).toEqual({ status: "flagged", notified: ["Anna"] });
    const rows = await outbox(f, "agent_flag");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientUserId: "user_a",
      title: "Margaret may be facing a scam",
      body: "A caller said her grandson is in jail and asked for gift cards.",
      payload: { reason: "scam", flaggedAt: NOW, conversationId: f.conversationId },
    });
    const audits = await auditRows(f, "flag_caregiver");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "agent",
      detail: { reason: "scam", recipients: ["user_a"], conversationId: f.conversationId },
    });
  });

  test("a long model detail reaches the caregiver as at most two sentences", async () => {
    const f = await setup();
    await f.t.mutation(api.agent.flagCaregiver, {
      agentKey: KEY,
      householdId: f.householdId,
      reason: "symptom",
      detail:
        "She says she feels dizzy.\nIt started after lunch. She also mentioned her knee, her " +
        "neighbor, the weather and a long story about the bus.",
      now: NOW,
    });
    const [flag] = await outbox(f, "agent_flag");
    expect(flag!.body).toBe("She says she feels dizzy. It started after lunch.");
    const [audited] = await auditRows(f, "flag_caregiver");
    expect(audited!.detail.detail).toBe(flag!.body);
  });

  test("falls back to every caregiver when no one is on call", async () => {
    const f = await setup();
    await addFamily(f);
    await f.t.run(async (ctx) => await ctx.db.patch(f.householdId, { onCallUserId: undefined }));
    const result = await f.t.mutation(api.agent.flagCaregiver, {
      agentKey: KEY,
      householdId: f.householdId,
      reason: "distress",
      detail: "She said she is scared and does not know where she is.",
      now: NOW,
    });
    expect(result.notified.sort()).toEqual(["Anna", "Bob", "Sarah Lee"]);
    expect((await outbox(f, "agent_flag")).map((r) => r.recipientUserId).sort()).toEqual([
      "user_a",
      "user_b",
      "user_c",
    ]);
  });

  test("the same reason within 10 minutes is not sent again; later it is", async () => {
    const f = await setup();
    /**
     * purpose: Flag at an instant.
     * @param now: (number) Epoch ms.
     * @param reason: ("symptom" | "money_request") The reason.
     * @return: (Promise<object>) The result.
     */
    const flag = (now: number, reason: "symptom" | "money_request" = "symptom") =>
      f.t.mutation(api.agent.flagCaregiver, {
        agentKey: KEY,
        householdId: f.householdId,
        reason,
        detail: "Headache again",
        now,
      });
    expect((await flag(NOW)).status).toBe("flagged");
    expect(await flag(NOW + 5 * MINUTE)).toEqual({ status: "already_flagged", notified: ["Anna"] });
    expect((await flag(NOW + 5 * MINUTE, "money_request")).status).toBe("flagged");
    expect((await flag(NOW + FLAG_REPEAT_WINDOW_MS + MINUTE)).status).toBe("flagged");
    expect(await outbox(f, "agent_flag")).toHaveLength(3);
  });

  test("an unknown reason is rejected and other households are untouched", async () => {
    const f = await setup();
    const other = await otherHousehold(f.t);
    await expect(
      f.t.mutation(api.agent.flagCaregiver, {
        agentKey: KEY,
        householdId: f.householdId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reason: "bored" as any,
        detail: "x",
        now: NOW,
      }),
    ).rejects.toThrow();
    await f.t.mutation(api.agent.flagCaregiver, {
      agentKey: KEY,
      householdId: f.householdId,
      reason: "symptom",
      detail: "Dizzy",
      now: NOW,
    });
    expect(await outbox({ t: f.t, householdId: other }, "agent_flag")).toEqual([]);
  });
});

describe("sendFamilyMessage", () => {
  test("goes to the named caregiver and stores a senior message", async () => {
    const f = await setup();
    await addFamily(f);
    const result = await f.t.mutation(api.agent.sendFamilyMessage, {
      agentKey: KEY,
      householdId: f.householdId,
      to: " sarah\n",
      body: " I'm home ",
      conversationId: f.conversationId,
    });
    expect(result).toMatchObject({ status: "sent", recipients: ["Sarah Lee"] });
    const message = await f.t.run(async (ctx) => await ctx.db.get(result.messageId!));
    expect(message).toMatchObject({
      householdId: f.householdId,
      senderKind: "senior",
      body: "For sarah: I'm home",
    });
    expect(message!.senderUserId).toBeUndefined();
    const rows = await outbox(f, "family_message");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientUserId: "user_c",
      title: "Message from Margaret",
      body: "For sarah: I'm home",
      payload: { messageId: result.messageId },
    });
    expect((await auditRows(f, "send"))[0]).toMatchObject({
      entity: "familyMessage",
      detail: { to: "sarah", recipients: ["user_c"] },
    });
  });

  test("an unknown name or no name reaches every caregiver", async () => {
    const f = await setup();
    await addFamily(f);
    const unknown = await f.t.mutation(api.agent.sendFamilyMessage, {
      agentKey: KEY,
      householdId: f.householdId,
      to: "Tommy",
      body: "Happy birthday",
    });
    expect(unknown.status).toBe("sent_to_family");
    expect(unknown.recipients.sort()).toEqual(["Anna", "Bob", "Sarah Lee"]);
    expect((await outbox(f, "family_message")).map((r) => r.body)).toEqual([
      "For Tommy: Happy birthday",
      "For Tommy: Happy birthday",
      "For Tommy: Happy birthday",
    ]);
    const nobody = await f.t.mutation(api.agent.sendFamilyMessage, {
      agentKey: KEY,
      householdId: f.householdId,
      to: null,
      body: "I'm going for a walk",
    });
    expect(nobody.status).toBe("sent");
    expect(nobody.recipients).toHaveLength(3);
    const stored = await f.t.run(async (ctx) => await ctx.db.get(nobody.messageId!));
    expect(stored!.body).toBe("I'm going for a walk");
  });

  test("a blank message is invalid and nothing is stored", async () => {
    const f = await setup();
    await expect(
      f.t.mutation(api.agent.sendFamilyMessage, {
        agentKey: KEY,
        householdId: f.householdId,
        to: "Anna",
        body: "   ",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    expect(await f.t.run(async (ctx) => await ctx.db.query("familyMessages").collect())).toEqual(
      [],
    );
  });
});

describe("readLatestMessage", () => {
  test("returns the newest caregiver message and marks it seen once", async () => {
    const f = await setup();
    /**
     * purpose: Read the latest message at an instant.
     * @param now: (number) Epoch ms.
     * @return: (Promise<object | null>) The message.
     */
    const read = (now: number) =>
      f.t.mutation(api.agent.readLatestMessage, { agentKey: KEY, householdId: f.householdId, now });
    expect(await read(NOW)).toBeNull();
    const id = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("familyMessages", {
          householdId: f.householdId,
          senderKind: "caregiver",
          senderUserId: "user_a",
          body: "Coming at 2 with soup",
        }),
    );
    await f.t.run(
      async (ctx) =>
        await ctx.db.insert("familyMessages", {
          householdId: f.householdId,
          senderKind: "senior",
          body: "ok",
        }),
    );
    // Loading the context (the message is in it) is not reading it aloud.
    const context = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(context.latestMessage).toMatchObject({ seen: false });
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))!.seenAt).toBeUndefined();
    expect(await read(NOW)).toMatchObject({
      from: "Anna",
      body: "Coming at 2 with soup",
      seen: false,
    });
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))!.seenAt).toBe(NOW);
    expect(await read(NOW + HOUR)).toMatchObject({ seen: true });
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))!.seenAt).toBe(NOW);
  });

  test("another household's message is not read or marked", async () => {
    const f = await setup();
    const other = await otherHousehold(f.t);
    const id = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("familyMessages", {
          householdId: other,
          senderKind: "caregiver",
          body: "Hi Dad",
        }),
    );
    expect(
      await f.t.mutation(api.agent.readLatestMessage, {
        agentKey: KEY,
        householdId: f.householdId,
        now: NOW,
      }),
    ).toBeNull();
    expect((await f.t.run(async (ctx) => await ctx.db.get(id)))!.seenAt).toBeUndefined();
  });
});

describe("logQuestions", () => {
  test("stores normalized rows the digest counts as repeats and unanswered", async () => {
    const f = await setup();
    const inserted = await f.t.mutation(api.agent.logQuestions, {
      agentKey: KEY,
      conversationId: f.conversationId,
      questions: [
        asked("When is Sarah coming?", " Sarah Visit ", { askedAt: NOW }),
        asked("When is Sarah coming today?", "sarah visit", { toolsUsed: ["list_today"] }),
        asked("What's my pension number?", "pension", { outcome: "unsure" }),
        asked("  ", "blank"),
      ],
    });
    expect(inserted).toBe(3);
    const rows = await f.t.run(async (ctx) => await ctx.db.query("agentQuestions").collect());
    expect(rows.map((r) => [r.topic, r.askedAt, r.conversationId, r.householdId])).toEqual([
      ["sarah visit", NOW, f.conversationId, f.householdId],
      ["sarah visit", NOW, f.conversationId, f.householdId],
      ["pension", NOW, f.conversationId, f.householdId],
    ]);
    expect(rows[1]!.toolsUsed).toEqual(["list_today"]);
    const facts = await f.t.run(async (ctx) =>
      gatherDigestFacts(ctx, (await ctx.db.get(f.householdId))!, "2027-03-10"),
    );
    expect(facts).toMatchObject({
      questionCount: 3,
      repeats: [{ topic: "sarah visit", count: 2 }],
      // Transcripts are not shared in this household, so the topic, not the words.
      unanswered: ["pension"],
    });
  });

  test("more than 50 questions is invalid; an unknown conversation is not_found", async () => {
    const f = await setup();
    const q = asked("q", "t");
    await expect(
      f.t.mutation(api.agent.logQuestions, {
        agentKey: KEY,
        conversationId: f.conversationId,
        questions: Array.from({ length: 51 }, () => q),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await f.t.run(async (ctx) => await ctx.db.delete(f.conversationId));
    await expect(
      f.t.mutation(api.agent.logQuestions, {
        agentKey: KEY,
        conversationId: f.conversationId,
        questions: [q],
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("is idempotent per conversation", async () => {
    const f = await setup();
    /**
     * purpose: Log one question for the fixture's conversation.
     * @return: (Promise<number>) Rows inserted.
     */
    const log = () =>
      f.t.mutation(api.agent.logQuestions, {
        agentKey: KEY,
        conversationId: f.conversationId,
        questions: [asked("When is Sarah coming?", "sarah visit")],
      });
    expect(await log()).toBe(1);
    expect(await log()).toBe(0);
    expect(
      await f.t.run(async (ctx) => await ctx.db.query("agentQuestions").collect()),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes (2026-11-09): reachability, dose repeats and undo, as-needed scope, caps
// ---------------------------------------------------------------------------------------------

/**
 * purpose: Make a member's phone unverified, so they cannot be texted.
 * @param f: (World) Harness and household.
 * @param userId: (string) The member.
 * @return: (Promise<void>) Resolves when written.
 */
async function unreachable(f: World, userId: string): Promise<void> {
  await setPhone(f.t, f.householdId, userId, "+15555550199", false);
}

/**
 * purpose: Flag a caregiver at an instant.
 * @param f: (World) Harness and household.
 * @param reason: (string) The model-facing reason.
 * @param now: (number) Epoch ms.
 * @param detail: (string) The detail.
 * @return: (Promise<FlagResult-shaped object>) The result.
 */
async function flagAt(
  f: World,
  reason: "symptom" | "money_request" | "scam" | "distress" | "help_requested",
  now: number,
  detail = "Dizzy",
) {
  return await f.t.mutation(api.agent.flagCaregiver, {
    agentKey: KEY,
    householdId: f.householdId,
    reason,
    detail,
    now,
  });
}

describe("reachability: nobody is named as told without a queued text", () => {
  test("an unreachable on-call caregiver falls back to the reachable ones", async () => {
    const f = await setup();
    await addFamily(f);
    await unreachable(f, "user_a");
    const result = await flagAt(f, "distress", NOW);
    expect(result.status).toBe("flagged");
    expect(result.notified.sort()).toEqual(["Bob", "Sarah Lee"]);
    expect((await outbox(f, "agent_flag")).map((r) => r.recipientUserId).sort()).toEqual([
      "user_b",
      "user_c",
    ]);
  });

  test("no verified phones: unreachable, nothing queued, still audited", async () => {
    const f = await setup();
    await unreachable(f, "user_a");
    expect(await flagAt(f, "distress", NOW)).toEqual({ status: "unreachable", notified: [] });
    expect(await outbox(f, "agent_flag")).toEqual([]);
    const [row] = await auditRows(f, "flag_caregiver");
    expect(row!.detail).toMatchObject({ status: "unreachable", recipients: [] });
    // An unreachable flag does not suppress the next one.
    await setPhone(f.t, f.householdId, "user_a", "+15555550101");
    expect((await flagAt(f, "distress", NOW + MINUTE)).status).toBe("flagged");
  });

  test("no members at all: unreachable", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      for (const m of await ctx.db.query("householdMembers").collect()) await ctx.db.delete(m._id);
    });
    expect(await flagAt(f, "help_requested", NOW)).toEqual({ status: "unreachable", notified: [] });
    const message = await f.t.mutation(api.agent.sendFamilyMessage, {
      agentKey: KEY,
      householdId: f.householdId,
      body: "I'm home",
    });
    expect(message).toMatchObject({ status: "unreachable", recipients: [] });
  });

  test("an unreachable family message is still stored and audited", async () => {
    const f = await setup();
    await unreachable(f, "user_a");
    const result = await f.t.mutation(api.agent.sendFamilyMessage, {
      agentKey: KEY,
      householdId: f.householdId,
      to: "Anna",
      body: "I'm home",
    });
    expect(result.status).toBe("unreachable");
    const stored = await f.t.run(async (ctx) => await ctx.db.get(result.messageId!));
    expect(stored!.body).toBe("For Anna: I'm home");
    expect(await outbox(f, "family_message")).toEqual([]);
    expect((await auditRows(f, "send"))[0]!.detail).toMatchObject({ status: "unreachable" });
  });

  test("a named caregiver without a phone gets it through the reachable family", async () => {
    const f = await setup();
    await addFamily(f);
    await unreachable(f, "user_c");
    const result = await f.t.mutation(api.agent.sendFamilyMessage, {
      agentKey: KEY,
      householdId: f.householdId,
      to: "Sarah",
      body: "I'm home",
    });
    expect(result.status).toBe("sent_to_family");
    expect(result.recipients.sort()).toEqual(["Anna", "Bob"]);
  });
});

describe("flag keys, caps and detail", () => {
  test("medication_limit is not a reason the model can use", async () => {
    const f = await setup();
    await expect(
      f.t.mutation(api.agent.flagCaregiver, {
        agentKey: KEY,
        householdId: f.householdId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reason: "medication_limit" as any,
        detail: "x",
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  test("two medications past a limit both reach family within minutes", async () => {
    const f = await setup();
    const relief = await insertTask(f, { title: "Pain reliever", asNeededMaxPerDay: 1 });
    const antacid = await insertTask(f, { title: "Antacid", asNeededMaxPerDay: 1 });
    await insertDose(f, relief, MIDNIGHT + HOUR);
    await insertDose(f, antacid, MIDNIGHT + HOUR);
    for (const [label, now] of [
      ["pain", NOW],
      ["antacid", NOW + 5 * MINUTE],
    ] as const) {
      const result = await f.t.mutation(api.agent.logAsNeededDose, {
        agentKey: KEY,
        householdId: f.householdId,
        label,
        now,
      });
      expect(result).toMatchObject({ status: "logged", flagStatus: "flagged", flagged: ["Anna"] });
    }
    expect(await outbox(f, "agent_flag")).toHaveLength(2);
  });

  test("at most 12 flags an hour reach family; the rest are audited as rate_limited", async () => {
    const f = await setup();
    const reasons = ["symptom", "money_request", "scam", "distress", "help_requested"] as const;
    const results = [];
    for (let i = 0; i < 13; i++) {
      // A different reason each time within the 10-minute window would repeat; space them out.
      results.push(await flagAt(f, reasons[i % reasons.length]!, NOW + i * 4 * MINUTE + i));
    }
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === "flagged").length).toBeLessThanOrEqual(12);
    expect(statuses).toContain("rate_limited");
    const audits = await auditRows(f, "flag_caregiver");
    expect(audits.some((a) => a.detail.status === "rate_limited")).toBe(true);
  });

  test("long digit runs never reach a caregiver", async () => {
    const f = await setup();
    await flagAt(f, "scam", NOW, "He asked for card 4111 1111 1111 1111. Then the bank.");
    const [flag] = await outbox(f, "agent_flag");
    expect(flag!.body).toBe("He asked for card [number removed]. Then the bank.");
  });
});

describe("family message caps", () => {
  test("an identical message within 2 minutes is not sent twice", async () => {
    const f = await setup();
    /**
     * purpose: Send "I'm home".
     * @return: (Promise<object>) The result.
     */
    const send = () =>
      f.t.mutation(api.agent.sendFamilyMessage, {
        agentKey: KEY,
        householdId: f.householdId,
        body: "I'm home",
      });
    const first = await send();
    expect(first.status).toBe("sent");
    vi.setSystemTime(NOW + MINUTE);
    expect(await send()).toEqual({
      status: "already_sent",
      messageId: first.messageId,
      recipients: [],
    });
    vi.setSystemTime(NOW + 3 * MINUTE);
    expect((await send()).status).toBe("sent");
  });

  test("past 10 messages an hour nothing is stored and the audit says so", async () => {
    const f = await setup();
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(NOW + i * MINUTE);
      const result = await f.t.mutation(api.agent.sendFamilyMessage, {
        agentKey: KEY,
        householdId: f.householdId,
        body: `Message ${i}`,
      });
      expect(result.status).toBe("sent");
    }
    vi.setSystemTime(NOW + 11 * MINUTE);
    const blocked = await f.t.mutation(api.agent.sendFamilyMessage, {
      agentKey: KEY,
      householdId: f.householdId,
      body: "One more",
    });
    expect(blocked).toEqual({ status: "rate_limited", messageId: null, recipients: [] });
    expect(
      await f.t.run(async (ctx) => await ctx.db.query("familyMessages").collect()),
    ).toHaveLength(10);
    const audits = await auditRows(f, "send");
    expect(audits.at(-1)!.detail).toMatchObject({ status: "rate_limited" });
  });
});

describe("doses: repeats, undo, scope and the 24-hour window", () => {
  test("the same dose told again within 30 minutes is not logged twice", async () => {
    const f = await setup();
    const relief = await insertTask(f, { title: "Pain reliever", asNeededMaxPerDay: 1 });
    /**
     * purpose: Report a dose at an instant.
     * @param now: (number) Epoch ms.
     * @return: (Promise<object>) The result.
     */
    const report = (now: number) =>
      f.t.mutation(api.agent.logAsNeededDose, { agentKey: KEY, householdId: f.householdId, now });
    expect((await report(NOW)).status).toBe("logged");
    expect(await report(NOW + 10 * MINUTE)).toMatchObject({
      status: "already_logged",
      takenAt: NOW,
    });
    const doses = await f.t.run(async (ctx) => await ctx.db.query("doseLog").collect());
    expect(doses.filter((d) => d.taskId === relief)).toHaveLength(1);
    expect(await outbox(f, "agent_flag")).toEqual([]);
  });

  test("undo removes today's latest voice dose, audits it and leaves a sent flag", async () => {
    const f = await setup();
    const relief = await insertTask(f, { title: "Pain reliever", asNeededMaxPerDay: 1 });
    await insertDose(f, relief, MIDNIGHT + HOUR);
    const logged = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(logged).toMatchObject({ status: "logged", flagStatus: "flagged" });
    const undone = await f.t.mutation(api.agent.undoLastDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW + MINUTE,
    });
    expect(undone).toEqual({ status: "removed", displayLabel: "Pain reliever", takenAt: NOW });
    const doses = await f.t.run(async (ctx) => await ctx.db.query("doseLog").collect());
    expect(doses.map((d) => d.takenAt)).toEqual([MIDNIGHT + HOUR]);
    expect(await auditRows(f, "undo_dose")).toHaveLength(1);
    expect(await outbox(f, "agent_flag")).toHaveLength(1);
    // The button dose of the morning is not the senior's voice report: nothing left to undo.
    expect(
      await f.t.mutation(api.agent.undoLastDose, {
        agentKey: KEY,
        householdId: f.householdId,
        now: NOW + 2 * MINUTE,
      }),
    ).toMatchObject({ status: "nothing_to_undo" });
  });

  test("a scheduled medication carrying stale limits is never as-needed", async () => {
    const f = await setup();
    const scheduled = await insertTask(f, { title: "Morning pills", asNeededMaxPerDay: 2 });
    await f.t.run(async (ctx) => await ctx.db.patch(scheduled, { times: ["08:00"] }));
    const context = await f.t.query(api.agent.getContext, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(context.asNeeded).toEqual([]);
    expect(
      await f.t.mutation(api.agent.logAsNeededDose, {
        agentKey: KEY,
        householdId: f.householdId,
        label: "morning",
        now: NOW,
      }),
    ).toEqual({ status: "no_rule", options: [] });
  });

  test("an unnamed dose while a scheduled medication is due is that one, not as-needed", async () => {
    const f = await setup();
    await insertTask(f, { title: "Pain reliever", asNeededMaxPerDay: 3 });
    const morning = await insertTask(f, { title: "Morning pills" });
    await f.t.run(async (ctx) => await ctx.db.patch(morning, { times: ["09:30"] }));
    await insertInstance(f, morning);
    const result = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(result).toEqual({ status: "scheduled_due", options: ["Morning pills"] });
    expect(await f.t.run(async (ctx) => await ctx.db.query("doseLog").collect())).toEqual([]);
    // Naming the as-needed one still logs it.
    expect(
      (
        await f.t.mutation(api.agent.logAsNeededDose, {
          agentKey: KEY,
          householdId: f.householdId,
          label: "pain",
          now: NOW,
        })
      ).status,
    ).toBe("logged");
  });

  test("four evening doses keep a 4-in-24-hours label closed just after midnight", async () => {
    const f = await setup();
    const relief = await insertTask(f, {
      title: "Pain reliever",
      asNeededMaxPerDay: 4,
      asNeededMinHours: 1,
    });
    // 6, 8, 10 and 11 PM on March 9 (New York, EST).
    const evening = [18, 20, 22, 23].map((h) => MIDNIGHT - 24 * HOUR + h * HOUR);
    for (const t of evening) await insertDose(f, relief, t);
    const justAfterMidnight = MIDNIGHT + 5 * MINUTE;
    const status = await f.t.query(api.agent.medicationStatus, {
      agentKey: KEY,
      householdId: f.householdId,
      now: justAfterMidnight,
    });
    expect(status.asNeeded[0]).toMatchObject({
      takenToday: [],
      remainingToday: 0,
      nextWithinLabelAt: evening[0]! + 24 * HOUR,
    });
    const logged = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: justAfterMidnight,
    });
    expect(logged).toMatchObject({ overDailyMax: true, count: 5, flagStatus: "flagged" });
  });

  test("use on 4 of the last 7 days raises one symptom flag a week", async () => {
    const f = await setup();
    const relief = await insertTask(f, { title: "Pain reliever", asNeededMaxPerDay: 3 });
    for (const daysAgo of [1, 3, 5]) await insertDose(f, relief, NOW - daysAgo * 24 * HOUR);
    const first = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW,
    });
    expect(first).toMatchObject({
      status: "logged",
      flagStatus: null,
      repeatedUseFlagged: ["Anna"],
      medication: { daysUsedLast7: 4 },
    });
    const [flag] = await outbox(f, "agent_flag");
    expect(flag).toMatchObject({
      payload: { reason: "symptom" },
      body: "Margaret has taken Pain reliever on 4 of the last 7 days.",
    });
    const later = await f.t.mutation(api.agent.logAsNeededDose, {
      agentKey: KEY,
      householdId: f.householdId,
      now: NOW + 2 * 24 * HOUR,
    });
    expect(later).toMatchObject({ status: "logged", repeatedUseFlagged: [] });
    expect(await outbox(f, "agent_flag")).toHaveLength(1);
  });
});
