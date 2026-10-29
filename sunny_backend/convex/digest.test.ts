// digest.test.ts
// Purpose: Tests for the daily digest (digest.ts, lib/digest.ts, lib/digestFacts.ts,
// lib/digestText.ts). The model (lib/digestModel) and the providers are mocked, so nothing
// leaves the process. Covers: timing from the scheduler tick (before and at digestTime, once
// per local date, the next day again, a zone far from UTC, a DST day with digestTime in the
// skipped hour, paused households, households created after the day's digest time); fact
// gathering (only the household's local day, task outcomes with times and who resolved or
// claimed, as-needed doses, unanswered and repeated questions); the compose action (Claude
// path, invalid model output and API error falling back to the template, quiet day without a
// model call, recipients limited to verified phones, no duplicate on a repeated run); reply
// validation and the template as pure functions; the completion handler; and one end-to-end
// run through the workpool.
//
// Last modified: 2026-10-29

import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { deliveryFixture, providerMocks, resetProviderMocks } from "./deliveryMocks.helpers";
import type { DeliveryFixture } from "./deliveryMocks.helpers";
import { factsForPrompt, templateDigest, validateDigestReply } from "./lib/digestText";
import type { DigestFacts } from "./lib/digestFacts";
import { makeBackend } from "./testing.helpers";

const modelMock = vi.hoisted(() => vi.fn());

vi.mock("./apns", async () => (await import("./deliveryMocks.helpers")).apnsModule());
vi.mock("./sms", async () => (await import("./deliveryMocks.helpers")).smsModule());
vi.mock("./lib/digestModel", () => ({
  composeWithClaude: modelMock,
  DIGEST_MODEL: "claude-haiku-5-5",
}));

/** 07:00 New York on Mon 2 Nov 2026 (EST): the household is created before its digest time. */
const CREATED = Date.parse("2026-11-02T12:00:00Z");
/** 19:00 New York that day: the default digestTime. */
const DIGEST_TIME = Date.parse("2026-11-03T00:00:00Z");
const GOOD_REPLY = [
  "Margaret confirmed Morning pills at 8:05 AM.",
  "Evening pills were missed.",
  "She asked 4 questions.",
].join("\n");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CREATED);
  resetProviderMocks();
  modelMock.mockReset();
  modelMock.mockResolvedValue(GOOD_REPLY);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

/**
 * purpose: A family household created at CREATED.
 * @return: (Promise<DeliveryFixture>) The fixture.
 */
async function setup(): Promise<DeliveryFixture> {
  return await deliveryFixture(makeBackend());
}

/**
 * purpose: Run the household's scheduler pass at an instant.
 * @param f: (DeliveryFixture) Fixture.
 * @param iso: (number) Epoch ms.
 * @return: (Promise<void>) Resolves when the tick ran.
 */
async function tick(f: DeliveryFixture, now: number): Promise<void> {
  await f.t.mutation(internal.scheduler.tickHousehold, { householdId: f.householdId, now });
}

/**
 * purpose: All digests rows.
 * @param f: (DeliveryFixture) Fixture.
 * @return: (Promise<Doc<"digests">[]>) The rows.
 */
async function digests(f: DeliveryFixture): Promise<Doc<"digests">[]> {
  return await f.t.run(async (ctx) => await ctx.db.query("digests").collect());
}

/**
 * purpose: Insert a pending digest row for a local date.
 * @param f: (DeliveryFixture) Fixture.
 * @param localDate: (string) Local date.
 * @return: (Promise<Id<"digests">>) The digest.
 */
async function pendingDigest(f: DeliveryFixture, localDate = "2026-11-02"): Promise<Id<"digests">> {
  return await f.t.run(
    async (ctx) =>
      await ctx.db.insert("digests", { householdId: f.householdId, localDate, status: "pending" }),
  );
}

/**
 * purpose: Run the compose action.
 * @param f: (DeliveryFixture) Fixture.
 * @param digestId: (Id<"digests">) The digest.
 * @return: The outcome.
 */
async function compose(f: DeliveryFixture, digestId: Id<"digests">) {
  return await f.t.action(internal.digest.compose, { digestId });
}

/**
 * purpose: Outbox rows of kind digest.
 * @param f: (DeliveryFixture) Fixture.
 * @return: (Promise<Doc<"notificationOutbox">[]>) The rows.
 */
async function digestRows(f: DeliveryFixture): Promise<Doc<"notificationOutbox">[]> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("notificationOutbox").collect());
  return rows.filter((r) => r.kind === "digest");
}

/** Fields of a task instance to insert for facts tests. */
interface InstanceSpec {
  label: string;
  localDate?: string;
  scheduledTime: string;
  windowStart: number;
  state: Doc<"taskInstances">["state"];
  confirmedAt?: number;
  confirmedVia?: Doc<"taskInstances">["confirmedVia"];
  confirmedBy?: string;
  claimedBy?: string;
  alerted?: boolean;
}

/**
 * purpose: Insert a task with one instance.
 * @param f: (DeliveryFixture) Fixture.
 * @param spec: (InstanceSpec) The instance.
 * @return: (Promise<void>) Resolves when inserted.
 */
async function addInstance(f: DeliveryFixture, spec: InstanceSpec): Promise<void> {
  await f.t.run(async (ctx) => {
    const taskId = await ctx.db.insert("tasks", {
      householdId: f.householdId,
      type: "medication",
      title: spec.label,
      displayLabel: spec.label,
      spokenPrompt: "Time.",
      checklistItems: [],
      times: [spec.scheduledTime],
      windowMinutes: 60,
      createdByKind: "caregiver",
      active: true,
      scheduleChangedAt: 0,
    });
    await ctx.db.insert("taskInstances", {
      taskId,
      householdId: f.householdId,
      localDate: spec.localDate ?? "2026-11-02",
      scheduledTime: spec.scheduledTime,
      windowStart: spec.windowStart,
      windowEnd: spec.windowStart + 3_600_000,
      state: spec.state,
      confirmedAt: spec.confirmedAt,
      confirmedVia: spec.confirmedVia,
      confirmedBy: spec.confirmedBy,
      claimedBy: spec.claimedBy,
      createdAt: 0,
      firedSteps: spec.alerted
        ? [{ stepId: "s2", action: "alert_on_call", firedAt: 1, notified: true }]
        : [],
    });
  });
}

/**
 * purpose: Insert a question the senior asked.
 * @param f: (DeliveryFixture) Fixture.
 * @param askedAt: (number) Epoch ms.
 * @param topic: (string) Topic.
 * @param outcome: (string) Outcome.
 * @param question: (string, optional) Question text.
 * @return: (Promise<void>) Resolves when inserted.
 */
async function addQuestion(
  f: DeliveryFixture,
  askedAt: number,
  topic: string,
  outcome: "answered" | "routed" | "unsure" = "answered",
  question = `What about ${topic}?`,
): Promise<void> {
  await f.t.run(async (ctx) => {
    await ctx.db.insert("agentQuestions", {
      householdId: f.householdId,
      askedAt,
      question,
      topic,
      outcome,
      toolsUsed: [],
    });
  });
}

/**
 * purpose: Load the digest inputs.
 * @param f: (DeliveryFixture) Fixture.
 * @param digestId: (Id<"digests">) The digest.
 * @return: The loaded inputs, or null.
 */
async function load(f: DeliveryFixture, digestId: Id<"digests">) {
  return await f.t.query(internal.digest.load, { digestId });
}

describe("timing", () => {
  test("no digest before the household's digestTime", async () => {
    const f = await setup();
    await tick(f, DIGEST_TIME - 60_000);
    expect(await digests(f)).toHaveLength(0);
  });

  test("a digest is recorded at digestTime", async () => {
    const f = await setup();
    await tick(f, DIGEST_TIME);
    const rows = await digests(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      householdId: f.householdId,
      localDate: "2026-11-02",
      status: "pending",
    });
  });

  test("ticks later the same local day do not add another", async () => {
    const f = await setup();
    await tick(f, DIGEST_TIME);
    await tick(f, DIGEST_TIME + 60_000);
    await tick(f, DIGEST_TIME + 3 * 3_600_000);
    expect(await digests(f)).toHaveLength(1);
  });

  test("the next local day gets its own digest", async () => {
    const f = await setup();
    await tick(f, DIGEST_TIME);
    await tick(f, DIGEST_TIME + 24 * 3_600_000);
    expect((await digests(f)).map((d) => d.localDate).sort()).toEqual(["2026-11-02", "2026-11-03"]);
  });

  test("a zone far from UTC follows its own local clock", async () => {
    vi.setSystemTime(Date.parse("2026-11-01T18:00:00Z"));
    const t = makeBackend();
    const f = await deliveryFixture(t, "Pacific/Auckland");
    // 18:30 in Auckland (UTC+13) on 2 Nov is 05:30Z; 19:00 there is 06:00Z.
    await tick(f, Date.parse("2026-11-02T05:59:00Z"));
    expect(await digests(f)).toHaveLength(0);
    await tick(f, Date.parse("2026-11-02T06:00:00Z"));
    expect((await digests(f))[0]?.localDate).toBe("2026-11-02");
  });

  test("a digestTime inside the skipped DST hour fires once, after the clocks jump", async () => {
    // New York springs forward on 14 Mar 2027: 02:00 EST becomes 03:00 EDT.
    vi.setSystemTime(Date.parse("2027-03-13T12:00:00Z"));
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.patch(f.householdId, { digestTime: "02:30" }));
    vi.setSystemTime(Date.parse("2027-03-13T12:00:01Z"));
    await tick(f, Date.parse("2027-03-14T06:59:00Z")); // 01:59 EST
    expect(await digests(f)).toHaveLength(0);
    await tick(f, Date.parse("2027-03-14T07:00:00Z")); // 03:00 EDT
    await tick(f, Date.parse("2027-03-14T07:01:00Z"));
    const rows = await digests(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.localDate).toBe("2027-03-14");
  });

  test("a paused household gets no digest until it resumes", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.patch(f.householdId, { backgroundPaused: true }));
    await tick(f, DIGEST_TIME);
    expect(await digests(f)).toHaveLength(0);
    await f.t.run(async (ctx) => await ctx.db.patch(f.householdId, { backgroundPaused: false }));
    await tick(f, DIGEST_TIME + 60_000);
    expect(await digests(f)).toHaveLength(1);
  });

  test("a household created after that day's digest time gets none that day", async () => {
    vi.setSystemTime(DIGEST_TIME + 3_600_000);
    const f = await setup();
    await tick(f, DIGEST_TIME + 2 * 3_600_000);
    expect(await digests(f)).toHaveLength(0);
  });
});

describe("facts", () => {
  test("only the household's local day is included", async () => {
    const f = await setup();
    // Local 2 Nov (EST) runs from 05:00Z on the 2nd to 05:00Z on the 3rd.
    await addQuestion(f, Date.parse("2026-11-03T04:30:00Z"), "in the day");
    await addQuestion(f, Date.parse("2026-11-03T05:30:00Z"), "next day");
    await addQuestion(f, Date.parse("2026-11-02T04:30:00Z"), "previous day");
    await addInstance(f, {
      label: "Yesterday pills",
      localDate: "2026-11-01",
      scheduledTime: "08:00",
      windowStart: 1,
      state: "missed",
    });
    await addInstance(f, {
      label: "Today pills",
      scheduledTime: "08:00",
      windowStart: 2,
      state: "missed",
    });
    const digestId = await pendingDigest(f);
    const input = await load(f, digestId);
    expect(input?.factsMessage).toContain("Questions asked: 1");
    expect(input?.factsMessage).toContain("Today pills");
    expect(input?.factsMessage).not.toContain("Yesterday pills");
    expect(input?.factsMessage).not.toContain("next day");
  });

  test("tasks, resolutions, claims, doses and questions are all reported", async () => {
    const f = await setup();
    await addInstance(f, {
      label: "Morning pills",
      scheduledTime: "08:00",
      windowStart: 1,
      state: "confirmed",
      confirmedAt: Date.parse("2026-11-02T13:05:00Z"),
      confirmedVia: "voice",
    });
    await addInstance(f, {
      label: "Lunch pills",
      scheduledTime: "12:00",
      windowStart: 2,
      state: "resolved",
      confirmedAt: Date.parse("2026-11-02T17:10:00Z"),
      confirmedVia: "caregiver",
      confirmedBy: "pat",
    });
    await addInstance(f, {
      label: "Evening pills",
      scheduledTime: "18:00",
      windowStart: 3,
      state: "missed",
      alerted: true,
      claimedBy: "pat",
    });
    await addInstance(f, {
      label: "Walk",
      scheduledTime: "15:00",
      windowStart: 4,
      state: "upcoming",
    });
    await f.t.run(async (ctx) => {
      const taskId = await ctx.db.insert("tasks", {
        householdId: f.householdId,
        type: "medication",
        title: "Tylenol",
        displayLabel: "Tylenol",
        spokenPrompt: "x",
        checklistItems: [],
        times: [],
        windowMinutes: 60,
        createdByKind: "caregiver",
        active: true,
        scheduleChangedAt: 0,
      });
      await ctx.db.insert("doseLog", {
        householdId: f.householdId,
        taskId,
        takenAt: Date.parse("2026-11-02T19:00:00Z"),
        reportedVia: "voice",
      });
      await ctx.db.insert("doseLog", {
        householdId: f.householdId,
        taskId,
        takenAt: Date.parse("2026-11-01T19:00:00Z"),
        reportedVia: "voice",
      });
    });
    const at = Date.parse("2026-11-02T20:00:00Z");
    for (let i = 0; i < 3; i++) await addQuestion(f, at + i, "Sarah Visit");
    await addQuestion(f, at + 9, "bank card", "unsure", "Where is my bank card?");
    await addQuestion(f, at + 10, "doctor", "routed", "Can I stop my pills?");
    const input = await load(f, await pendingDigest(f));
    expect(input?.template.split("\n")).toEqual([
      "Confirmed: Morning pills at 8:05 AM (voice); Lunch pills at 12:10 PM (marked done by Pat).",
      "Missed: Evening pills (6:00 PM).",
      "Caregiver alerts sent for: Evening pills (claimed by Pat).",
      "As-needed doses: Tylenol at 2:00 PM.",
      "5 questions asked. Unanswered: Where is my bank card. Passed to family: Can I stop my pills.",
    ]);
    expect(input?.quiet).toBe(false);
    expect(input?.factsMessage).toContain("Repeated topic: sarah visit, 3 times");
    expect(input?.factsMessage).not.toContain("Walk");
  });

  test("a deleted task's instance is left out", async () => {
    const f = await setup();
    await addInstance(f, {
      label: "Gone",
      scheduledTime: "08:00",
      windowStart: 1,
      state: "missed",
    });
    await f.t.run(async (ctx) => {
      const task = (await ctx.db.query("tasks").first())!;
      await ctx.db.delete(task._id);
    });
    expect((await load(f, await pendingDigest(f)))?.quiet).toBe(true);
  });

  test("load returns null for a digest that is no longer pending", async () => {
    const f = await setup();
    const digestId = await pendingDigest(f);
    await f.t.run(async (ctx) => await ctx.db.patch(digestId, { status: "sent" }));
    expect(await load(f, digestId)).toBeNull();
  });

  test("the recipient count is the members with a verified phone", async () => {
    const f = await setup();
    expect((await load(f, await pendingDigest(f)))?.recipients).toBe(2);
  });
});

describe("compose", () => {
  /**
   * purpose: Give the day something to report so it is not a quiet day.
   * @param f: (DeliveryFixture) Fixture.
   * @return: (Promise<void>) Resolves when added.
   */
  async function addActivity(f: DeliveryFixture): Promise<void> {
    await addInstance(f, {
      label: "Morning pills",
      scheduledTime: "08:00",
      windowStart: 1,
      state: "confirmed",
      confirmedAt: Date.parse("2026-11-02T13:05:00Z"),
      confirmedVia: "voice",
    });
  }

  test("the Claude path stores the text and queues one row per verified phone", async () => {
    const f = await setup();
    await addActivity(f);
    const digestId = await pendingDigest(f);
    expect(await compose(f, digestId)).toBe("claude");
    expect(modelMock).toHaveBeenCalledTimes(1);
    expect(modelMock.mock.calls[0]![0]).toContain("<facts>");
    const row = (await digests(f))[0]!;
    expect(row).toMatchObject({
      status: "sent",
      source: "claude",
      text: GOOD_REPLY,
      recipients: 2,
    });
    const rows = await digestRows(f);
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual(["max", "pat"]);
    expect(rows[0]).toMatchObject({
      householdId: f.householdId,
      kind: "digest",
      body: GOOD_REPLY,
      title: "Sunny: Mom's day",
    });
  });

  test("an unverified phone and a member without a phone get no row", async () => {
    const f = await setup();
    await addActivity(f);
    await compose(f, await pendingDigest(f));
    const users = (await digestRows(f)).map((r) => r.recipientUserId);
    expect(users).not.toContain("val");
  });

  test.each([
    ["too many lines", "a\nb\nc\nd\ne\nf"],
    ["too long", "x".repeat(601)],
    ["markdown", "**Bold** line"],
    ["a bullet list", "- one\n- two"],
    ["an emoji", "All good \u{1F600}"],
    ["empty", "   \n  "],
  ])("invalid model output (%s) falls back to the template", async (_label, reply) => {
    const f = await setup();
    await addActivity(f);
    modelMock.mockResolvedValue(reply);
    expect(await compose(f, await pendingDigest(f))).toBe("template");
    const row = (await digests(f))[0]!;
    expect(row.source).toBe("template");
    expect(row.text).toBe("Confirmed: Morning pills at 8:05 AM (voice).");
    expect(row.status).toBe("sent");
  });

  test("a model API error falls back to the template", async () => {
    const f = await setup();
    await addActivity(f);
    modelMock.mockRejectedValue(new Error("529 overloaded"));
    expect(await compose(f, await pendingDigest(f))).toBe("template");
    expect((await digestRows(f))[0]?.body).toBe("Confirmed: Morning pills at 8:05 AM (voice).");
  });

  test("a quiet day sends the one-line message without calling the model", async () => {
    const f = await setup();
    expect(await compose(f, await pendingDigest(f))).toBe("template");
    expect(modelMock).not.toHaveBeenCalled();
    expect((await digests(f))[0]?.text).toBe("Mom: quiet day, nothing was logged.");
    expect(await digestRows(f)).toHaveLength(2);
  });

  test("with no verified phone nothing is queued and the model is not called", async () => {
    const f = await setup();
    await addActivity(f);
    await f.t.run(async (ctx) => {
      for (const m of await ctx.db.query("householdMembers").collect()) {
        await ctx.db.patch(m._id, { phoneVerifiedAt: undefined });
      }
    });
    await compose(f, await pendingDigest(f));
    expect(modelMock).not.toHaveBeenCalled();
    expect((await digests(f))[0]).toMatchObject({ status: "no_recipients", recipients: 0 });
    expect(await digestRows(f)).toHaveLength(0);
  });

  test("a second run for the same digest queues nothing more", async () => {
    const f = await setup();
    await addActivity(f);
    const digestId = await pendingDigest(f);
    await compose(f, digestId);
    expect(await compose(f, digestId)).toBe("skipped");
    expect(await digestRows(f)).toHaveLength(2);
    expect(modelMock).toHaveBeenCalledTimes(1);
  });

  test("a digest that was deleted is skipped", async () => {
    const f = await setup();
    const digestId = await pendingDigest(f);
    await f.t.run(async (ctx) => await ctx.db.delete(digestId));
    expect(await compose(f, digestId)).toBe("skipped");
  });

  test("the digest rows are delivered by SMS to the verified phones only", async () => {
    const f = await setup();
    await addActivity(f);
    await compose(f, await pendingDigest(f));
    for (const row of await digestRows(f)) {
      await f.t.action(internal.delivery.deliver, { outboxId: row._id });
    }
    const sent = providerMocks.smsSend.mock.calls.map((c) => c[0].to).sort();
    expect(sent).toEqual(["+15550000001", "+15550000002"]);
  });
});

describe("completion handler", () => {
  const WORK_ID = "work_1" as WorkId;

  test("a failed run marks a pending digest failed", async () => {
    const f = await setup();
    const digestId = await pendingDigest(f);
    await f.t.mutation(internal.digest.onComposeComplete, {
      workId: WORK_ID,
      context: { digestId },
      result: { kind: "failed", error: "boom" },
    });
    expect((await digests(f))[0]).toMatchObject({ status: "failed", error: "boom" });
  });

  test("success, or a digest already sent, changes nothing", async () => {
    const f = await setup();
    const digestId = await pendingDigest(f);
    await f.t.mutation(internal.digest.onComposeComplete, {
      workId: WORK_ID,
      context: { digestId },
      result: { kind: "success", returnValue: "claude" },
    });
    expect((await digests(f))[0]?.status).toBe("pending");
    await f.t.run(async (ctx) => await ctx.db.patch(digestId, { status: "sent" }));
    await f.t.mutation(internal.digest.onComposeComplete, {
      workId: WORK_ID,
      context: { digestId },
      result: { kind: "failed", error: "late" },
    });
    expect((await digests(f))[0]?.status).toBe("sent");
  });
});

describe("sweeper", () => {
  test("re-enqueues a digest left pending too long", async () => {
    const f = await setup();
    await pendingDigest(f);
    vi.setSystemTime(CREATED + 16 * 60_000);
    expect(await f.t.mutation(internal.delivery.sweepStuck, {})).toBe(1);
  });
});

describe("end to end", () => {
  test("a tick at digestTime ends with texts to the verified phones", async () => {
    const f = await setup();
    await addInstance(f, {
      label: "Morning pills",
      scheduledTime: "08:00",
      windowStart: 1,
      state: "confirmed",
      confirmedAt: Date.parse("2026-11-02T13:05:00Z"),
      confirmedVia: "voice",
    });
    vi.setSystemTime(DIGEST_TIME);
    await tick(f, DIGEST_TIME);
    for (let i = 0; i < 200 && providerMocks.smsSend.mock.calls.length < 2; i++) {
      let finished = false;
      void f.t.finishInProgressScheduledFunctions().then(() => {
        finished = true;
      });
      while (!finished) await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(1_100);
    }
    expect(providerMocks.smsSend).toHaveBeenCalledTimes(2);
    expect((await digests(f))[0]).toMatchObject({ status: "sent", source: "claude" });
  });
});

describe("text", () => {
  const facts: DigestFacts = {
    seniorName: "Mom",
    localDate: "2026-11-02",
    tasks: [],
    doses: [],
    questionCount: 0,
    unanswered: [],
    routed: [],
    repeats: [],
  };

  test("a valid reply is returned with trimmed lines", () => {
    expect(validateDigestReply("  Line one.  \r\n\nLine two, at 8:05 AM (voice).\n")).toBe(
      "Line one.\nLine two, at 8:05 AM (voice).",
    );
  });

  test("a reply of exactly five lines and 600 characters passes, one more fails", () => {
    expect(validateDigestReply("a\nb\nc\nd\ne")).not.toBeNull();
    expect(validateDigestReply("a\nb\nc\nd\ne\nf")).toBeNull();
    expect(validateDigestReply("x".repeat(600))).not.toBeNull();
    expect(validateDigestReply("x".repeat(601))).toBeNull();
  });

  test("curly apostrophes and accented letters are plain text", () => {
    expect(validateDigestReply("Renée’s pills at 8:05 AM.")).not.toBeNull();
  });

  test("the template stays under 600 characters with many long items", () => {
    const many: DigestFacts = {
      ...facts,
      tasks: Array.from({ length: 30 }, (_, i) => ({
        label: `A rather long task label number ${i}`,
        scheduledAt: "8:00 AM",
        outcome: "missed" as const,
        alerted: true,
        claimedBy: "Somebody With A Long Name",
      })),
      doses: Array.from({ length: 10 }, (_, i) => ({
        label: `Dose ${i}`,
        times: ["1:00 PM", "5:00 PM"],
      })),
      questionCount: 40,
      unanswered: Array.from({ length: 20 }, (_, i) => `an unanswered question number ${i}`),
      routed: [],
      repeats: [{ topic: "visit", count: 9 }],
    };
    const text = templateDigest(many);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
    expect(validateDigestReply(text)).not.toBeNull();
    expect(text).toMatch(/and \d+ more/);
  });

  test("the quiet-day line names the senior", () => {
    expect(templateDigest(facts)).toBe("Mom: quiet day, nothing was logged.");
  });

  test("the prompt message wraps the facts in tags and names no one else", () => {
    const text = factsForPrompt({
      ...facts,
      questionCount: 2,
      repeats: [{ topic: "visit", count: 2 }],
    });
    expect(text.startsWith("<facts>\n")).toBe(true);
    expect(text.endsWith("\n</facts>")).toBe(true);
    expect(text).toContain("Repeated topic: visit, 2 times");
  });
});
