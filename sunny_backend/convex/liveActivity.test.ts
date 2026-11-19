import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  APNS_SENT,
  alertsSent,
  answerEachToken,
  providerMocks,
  resetProviderMocks,
} from "./deliveryMocks.helpers";
import type { ApnsSendArgs } from "./deliveryMocks.helpers";
import { MAX_OPEN_ACTIVITIES, PROOF_WAIT_MS } from "./lib/liveActivity";
import {
  ALERT_TOKEN,
  MIN,
  START_TOKEN,
  UPDATE_TOKEN,
  about,
  activities,
  activityPushes,
  addTask,
  confirmOnDisplay,
  displayToken,
  local,
  makePhoneBackend,
  outbox,
  phoneHousehold,
  phonePushRow,
  postConfirm,
  proveStarts,
  putPushState,
  reportStartToken,
  secondPhone,
  setNow,
  settle,
  starts,
  tick,
} from "./phoneHarness.helpers";
import type { PhoneFixture, StartAps } from "./phoneHarness.helpers";

vi.mock("./apns", async (original) =>
  (await import("./deliveryMocks.helpers")).apnsModule(await original()),
);

const EIGHT = local("08:00");

const PILLS_PROMPT = "It's 8 o'clock. Time for your morning pills.";

beforeEach(() => {
  vi.useFakeTimers();
  setNow(local("07:00"));
  resetProviderMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(): Promise<PhoneFixture> {
  return await phoneHousehold(makePhoneBackend());
}

async function pills(f: PhoneFixture): Promise<Id<"taskInstances">> {
  return await addTask(f, {
    title: "Morning pills",
    time: "08:00",
    spokenPrompt: PILLS_PROMPT,
    screenSentence: "Take your morning pills.",
  });
}

async function deliverPrompt(f: PhoneFixture, instanceId: Id<"taskInstances">): Promise<string> {
  const row = (await outbox(f, instanceId)).find((r) => r.state === "pending")!;
  return await f.t.action(internal.delivery.deliver, { outboxId: row._id });
}

function refuseStart(result: { status: number; retryable?: boolean }): void {
  answerEachToken((token) =>
    token === START_TOKEN
      ? {
          outcome: result.status === 410 ? "unregistered" : "failed",
          status: result.status,
          reason: "Refused",
          retryable: result.retryable ?? false,
        }
      : APNS_SENT,
  );
}

describe("the due cue on a phone that reported a start token", () => {
  test("a tick that opens the window sends exactly one start and no notification", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    await tick(f, EIGHT);
    await settle(f.t);

    const [row] = await activities(f);
    expect(await activities(f)).toHaveLength(1);
    expect(row).toMatchObject({
      householdId: f.householdId,
      deviceId: f.phoneId,
      taskInstanceId: instanceId,
      windowEnd: EIGHT + 60 * MIN,
      phase: { kind: "started", proof: "awaited" },
    });
    expect(alertsSent()).toEqual([]);
    const [push] = activityPushes();
    expect(activityPushes()).toHaveLength(1);
    expect(push!.tokens).toEqual([START_TOKEN]);
    expect(push!.message).toMatchObject({
      pushType: "liveactivity",
      priority: 10,
      expiresAt: (EIGHT + 60 * MIN) / 1000,
    });
    expect(push!.payload.aps).toEqual({
      timestamp: expect.closeTo(EIGHT / 1000, -1),
      event: "start",
      "attributes-type": "SunnyTaskAttributes",
      attributes: {
        activityKey: row!._id,
        instanceId,
        receiptMs: 10_000,
      },
      "content-state": {
        card: {
          instanceId,
          step: 0,
          stepCount: 1,
          stepText: null,
          label: "Morning pills",
          sentence: "Take your morning pills.",
          detail: null,
          icon: "pills",
          startsAt: EIGHT,
          endsAt: EIGHT + 60 * MIN,
        },
        nextSteps: [],
        closed: null,
      },
      alert: { title: "Morning pills", body: PILLS_PROMPT, sound: "default" },
      "stale-date": (EIGHT + 60 * MIN) / 1000,
      "relevance-score": 4_000_000_000 - EIGHT / 1000,
    });
    expect(row!.shown).toEqual((push!.payload.aps as StartAps)["content-state"]);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ kind: "senior_prompt", state: "sent", channel: "live_activity" }),
    ]);
  });

  test("a tick that runs twice still gives one activity row and one start", async () => {
    const f = await setup();
    await reportStartToken(f);
    await pills(f);
    await tick(f, EIGHT);
    await tick(f, EIGHT);
    await settle(f.t);
    await tick(f, EIGHT + MIN);
    await settle(f.t);
    expect(await activities(f)).toHaveLength(1);
    expect(starts()).toHaveLength(1);
    expect(alertsSent()).toEqual([]);
  });

  test("the reprompt fifteen minutes later is a notification, not a second start", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    await tick(f, EIGHT);
    await settle(f.t);
    await putPushState(f, {
      activities: [{ key: (await activities(f))[0]!._id, token: null, state: "active" }],
    });
    await tick(f, EIGHT + 15 * MIN);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    expect(await activities(f)).toHaveLength(1);
    expect(alertsSent()).toEqual([
      {
        tokens: [ALERT_TOKEN],
        title: "Morning pills",
        body: PILLS_PROMPT,
        interruptionLevel: "time-sensitive",
        data: expect.objectContaining({ kind: "senior_prompt", task_instance_id: instanceId }),
      },
    ]);
    const rows = await outbox(f, instanceId);
    expect(rows.map((row) => row.channel)).toEqual(["live_activity", "apns"]);
  });

  test("two tasks due together get two starts, each bound to its own task", async () => {
    const f = await setup();
    await reportStartToken(f);
    const first = await pills(f);
    const second = await addTask(f, { title: "Eye drops", time: "08:00" });
    await tick(f, EIGHT);
    await settle(f.t);
    const rows = await activities(f);
    expect(rows.map((row) => row.taskInstanceId).sort()).toEqual([first, second].sort());
    expect(alertsSent()).toEqual([]);
    expect(
      starts()
        .map((aps) => [aps.attributes.activityKey, aps.attributes.instanceId, aps.alert.title])
        .sort(),
    ).toEqual(
      rows
        .map((row) => [
          row._id,
          row.taskInstanceId,
          row.taskInstanceId === first ? "Morning pills" : "Eye drops",
        ])
        .sort(),
    );
  });

  test("an earlier task ranks above a later one that comes due while it is up", async () => {
    const f = await setup();
    await reportStartToken(f);
    await pills(f);
    await addTask(f, { title: "Eye drops", time: "08:10" });
    await tick(f, EIGHT);
    await settle(f.t);
    await proveStarts(f);
    await tick(f, EIGHT + 10 * MIN);
    await settle(f.t);
    const [early, late] = starts();
    expect(starts()).toHaveLength(2);
    expect(early!.alert.title).toBe("Morning pills");
    expect(late!.alert.title).toBe("Eye drops");
    expect(early!["relevance-score"]).toBeGreaterThan(late!["relevance-score"]);
  });

  test("a task confirmed before its cue is delivered starts nothing", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    await tick(f, EIGHT);
    await f.t.run(async (ctx) => await ctx.db.patch(instanceId, { state: "confirmed" }));
    await settle(f.t);
    expect(activityPushes()).toEqual([]);
    expect(alertsSent()).toEqual([]);
    expect(await activities(f)).toEqual([]);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ state: "skipped", detail: "instance_closed" }),
    ]);
  });
});

describe("a phone where no Live Activity can start gets the notification as before", () => {
  async function expectNotificationOnly(
    f: PhoneFixture,
    instanceId: Id<"taskInstances">,
  ): Promise<void> {
    expect(activityPushes()).toEqual([]);
    expect(await activities(f)).toEqual([]);
    expect(alertsSent()).toEqual([
      expect.objectContaining({
        tokens: [ALERT_TOKEN],
        title: "Morning pills",
        body: PILLS_PROMPT,
        interruptionLevel: "time-sensitive",
      }),
    ]);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ state: "sent", channel: "apns" }),
    ]);
  }

  test("a phone that never reported", async () => {
    const f = await setup();
    const instanceId = await pills(f);
    await tick(f, EIGHT);
    await settle(f.t);
    await expectNotificationOnly(f, instanceId);
  });

  test("a phone that reported Live Activities turned off", async () => {
    const f = await setup();
    await putPushState(f, { liveActivityStart: { token: START_TOKEN, enabled: false } });
    const instanceId = await pills(f);
    await tick(f, EIGHT);
    await settle(f.t);
    await expectNotificationOnly(f, instanceId);
  });

  test("the home display is never sent a start, even with a stored start token", async () => {
    const f = await setup();
    await reportStartToken(f);
    await f.t.run(async (ctx) => {
      await ctx.db.insert("phonePush", {
        deviceId: f.displayId,
        liveActivityStart: { token: START_TOKEN, reportedAt: Date.now() },
      });
      await ctx.db.insert("pushTokens", { userId: f.displayUser, token: "display-alert-token" });
    });
    await pills(f);
    await tick(f, EIGHT);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    expect((await activities(f)).map((row) => row.deviceId)).toEqual([f.phoneId]);
    expect(alertsSent().map((alert) => alert.tokens)).toEqual([["display-alert-token"]]);
  });
});

describe("a start that APNs does not accept", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("a 410 deletes the start token and sends the notification in the same run", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    refuseStart({ status: 410 });
    await tick(f, EIGHT);
    expect(await deliverPrompt(f, instanceId)).toBe("sent");
    expect(starts()).toHaveLength(1);
    expect(alertsSent()).toEqual([
      expect.objectContaining({ tokens: [ALERT_TOKEN], title: "Morning pills" }),
    ]);
    expect((await phonePushRow(f))!.liveActivityStart).toBeUndefined();
    expect((await activities(f)).map((row) => row.phase)).toEqual([
      { kind: "ended", at: about(EIGHT), reason: "start_failed" },
    ]);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ state: "sent", channel: "apns", attempts: 1 }),
    ]);
  });

  test("another permanent refusal also falls back, and keeps the start token", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    refuseStart({ status: 400 });
    await tick(f, EIGHT);
    expect(await deliverPrompt(f, instanceId)).toBe("sent");
    expect(alertsSent()).toHaveLength(1);
    expect((await phonePushRow(f))!.liveActivityStart!.token).toBe(START_TOKEN);
    expect((await activities(f))[0]!.phase).toMatchObject({
      kind: "ended",
      reason: "start_failed",
    });
  });

  test("a retryable failure is retried with the same activity key", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    refuseStart({ status: 503, retryable: true });
    await tick(f, EIGHT);
    await expect(deliverPrompt(f, instanceId)).rejects.toThrow(/will retry/);
    expect(alertsSent()).toEqual([]);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ state: "pending", pushState: "retrying" }),
    ]);
    expect((await activities(f))[0]!.phase.kind).toBe("starting");

    const firstKey = starts()[0]!.attributes.activityKey;
    resetProviderMocks();
    expect(await deliverPrompt(f, instanceId)).toBe("sent");
    expect(starts().map((aps) => aps.attributes.activityKey)).toEqual([firstKey]);
    expect(await activities(f)).toHaveLength(1);
    expect((await activities(f))[0]!.phase.kind).toBe("started");
    expect(alertsSent()).toEqual([]);
  });

  test("retries that run out send the notification", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    refuseStart({ status: 503, retryable: true });
    await tick(f, EIGHT);
    await expect(deliverPrompt(f, instanceId)).rejects.toThrow(/will retry/);
    const [row] = await outbox(f, instanceId);
    await f.t.mutation(internal.delivery.onDeliveryComplete, {
      workId: "work_1" as WorkId,
      context: { outboxId: row!._id },
      result: { kind: "failed", error: "Live Activity start failed, will retry: 503 Refused" },
    });
    expect(await deliverPrompt(f, instanceId)).toBe("sent");
    expect(starts()).toHaveLength(1);
    expect(alertsSent()).toEqual([
      expect.objectContaining({ tokens: [ALERT_TOKEN], title: "Morning pills" }),
    ]);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ state: "sent", channel: "apns", pushState: "gave_up" }),
    ]);
    expect((await activities(f))[0]!.phase).toMatchObject({
      kind: "ended",
      reason: "start_failed",
    });
  });

  test("the whole retry run through the pool ends with one notification", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    refuseStart({ status: 503, retryable: true });
    await tick(f, EIGHT);
    await settle(f.t, 2 * MIN);
    expect(starts().length).toBeGreaterThan(1);
    expect(alertsSent()).toHaveLength(1);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ state: "sent", channel: "apns" }),
    ]);
    errorSpy.mockRestore();
  });
});

describe("a start that reached the phone while APNs answered with a failure", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function loseTheFirstAnswer(f: PhoneFixture, reported: { token: string | null; state: string }) {
    let lost = false;
    providerMocks.apnsSend.mockImplementation(async (args: ApnsSendArgs) => {
      const [send] = args.sends;
      const aps = (JSON.parse(send!.message.body) as { aps: Partial<StartAps> }).aps;
      if (lost || aps.event !== "start" || aps.attributes === undefined) {
        return args.sends.map(({ token }) => ({ token, ...APNS_SENT }));
      }
      lost = true;
      const response = await putPushState(f, {
        activities: [{ key: aps.attributes.activityKey, ...reported }],
      });
      expect(response.status).toBe(200);
      return args.sends.map(({ token }) => ({
        token,
        outcome: "failed" as const,
        status: 0,
        reason: "Closed",
        retryable: true,
      }));
    });
  }

  test("the phone's report settles the cue, and no retry or notification follows", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    loseTheFirstAnswer(f, { token: UPDATE_TOKEN, state: "active" });
    await tick(f, EIGHT);
    await settle(f.t, 2 * MIN);

    expect(starts()).toHaveLength(1);
    expect(alertsSent()).toEqual([]);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ kind: "senior_prompt", state: "sent", channel: "live_activity" }),
    ]);
    expect((await activities(f)).map((row) => row.phase)).toEqual([
      expect.objectContaining({ kind: "live", updateToken: UPDATE_TOKEN }),
    ]);
    expect((await phonePushRow(f))!.blindSince).toBeUndefined();
  });

  test("an activity the senior swiped away before the answer gets no notification either", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    loseTheFirstAnswer(f, { token: null, state: "dismissed" });
    await tick(f, EIGHT);
    await settle(f.t, 2 * MIN);

    expect(starts()).toHaveLength(1);
    expect(alertsSent()).toEqual([]);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ state: "sent", channel: "live_activity" }),
    ]);
    expect((await activities(f)).map((row) => row.phase.kind)).toEqual(["ended"]);
  });

  test("the retries run out before the phone reports: the phone keeps the activity it shows", async () => {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    refuseStart({ status: 503, retryable: true });
    await tick(f, EIGHT);
    await settle(f.t, 2 * MIN);
    expect(alertsSent()).toHaveLength(1);
    const [row] = await activities(f);
    expect(row!.phase).toMatchObject({ kind: "ended", reason: "start_failed" });

    resetProviderMocks();
    const response = await putPushState(f, {
      activities: [{ key: row!._id, token: UPDATE_TOKEN, state: "active" }],
    });
    expect(((await response.json()) as { activities: unknown[] }).activities).toEqual([]);
    expect((await activities(f)).map((r) => r.phase)).toEqual([
      {
        kind: "live",
        acceptedAt: about(EIGHT + 2 * MIN),
        updateToken: UPDATE_TOKEN,
        tokenAt: about(EIGHT + 2 * MIN),
      },
    ]);

    await confirmOnDisplay(f, instanceId);
    await settle(f.t);
    expect(activityPushes().map((push) => push.tokens)).toEqual([[UPDATE_TOKEN]]);
    expect((await activities(f))[0]!.phase).toMatchObject({ kind: "ended", reason: "confirmed" });
  });

  test("a failed start the phone shows without an update token is kept as started", async () => {
    const f = await setup();
    await reportStartToken(f);
    await pills(f);
    refuseStart({ status: 503, retryable: true });
    await tick(f, EIGHT);
    await settle(f.t, 2 * MIN);
    const [row] = await activities(f);

    const response = await putPushState(f, {
      activities: [{ key: row!._id, token: null, state: "active" }],
    });
    expect(((await response.json()) as { activities: unknown[] }).activities).toEqual([]);
    expect((await activities(f))[0]!.phase).toEqual({
      kind: "started",
      acceptedAt: about(EIGHT + 2 * MIN),
      proof: "proven",
    });
  });

  test("a failed start the phone no longer shows stays ended", async () => {
    const f = await setup();
    await reportStartToken(f);
    await pills(f);
    refuseStart({ status: 503, retryable: true });
    await tick(f, EIGHT);
    await settle(f.t, 2 * MIN);
    const [row] = await activities(f);

    const response = await putPushState(f, {
      activities: [{ key: row!._id, token: null, state: "dismissed" }],
    });
    expect(((await response.json()) as { activities: unknown[] }).activities).toEqual([]);
    expect((await activities(f))[0]!.phase).toMatchObject({
      kind: "ended",
      reason: "start_failed",
    });
  });
});

describe("the proof check 45 seconds after a start is accepted", () => {
  async function started(): Promise<{ f: PhoneFixture; instanceId: Id<"taskInstances"> }> {
    const f = await setup();
    await reportStartToken(f);
    const instanceId = await pills(f);
    await tick(f, EIGHT);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    return { f, instanceId };
  }

  test("a phone that reported the activity in time gets no notification", async () => {
    const { f } = await started();
    await proveStarts(f);
    await settle(f.t, PROOF_WAIT_MS + 10_000);
    expect(alertsSent()).toEqual([]);
    expect((await phonePushRow(f))!.blindSince).toBeUndefined();
    expect((await activities(f))[0]!.phase).toMatchObject({ kind: "started", proof: "proven" });
  });

  test("nothing is sent before the 45 seconds are over", async () => {
    const { f } = await started();
    await settle(f.t, PROOF_WAIT_MS - 10_000);
    expect(alertsSent()).toEqual([]);
    expect((await phonePushRow(f))!.blindSince).toBeUndefined();
  });

  test("no report and the task still due: one notification, and the phone is blind", async () => {
    const { f, instanceId } = await started();
    await settle(f.t, PROOF_WAIT_MS + 10_000);
    expect(alertsSent()).toEqual([
      {
        tokens: [ALERT_TOKEN],
        title: "Morning pills",
        body: PILLS_PROMPT,
        interruptionLevel: "time-sensitive",
        data: expect.objectContaining({ kind: "senior_prompt", task_instance_id: instanceId }),
      },
    ]);
    expect(starts()).toHaveLength(1);
    expect((await phonePushRow(f))!.blindSince).toEqual(about(EIGHT + PROOF_WAIT_MS));
    expect((await activities(f)).map((row) => row.phase)).toEqual([
      { kind: "started", acceptedAt: about(EIGHT), proof: "missed" },
    ]);
  });

  test("no report and the task already done: the phone is blind and nothing is sent", async () => {
    const { f, instanceId } = await started();
    await confirmOnDisplay(f, instanceId);
    await settle(f.t, PROOF_WAIT_MS + 10_000);
    expect(alertsSent()).toEqual([]);
    expect((await phonePushRow(f))!.blindSince).toBeDefined();
  });

  test("a check that runs twice sends no second notification", async () => {
    const { f } = await started();
    await settle(f.t, PROOF_WAIT_MS + 10_000);
    expect(alertsSent()).toHaveLength(1);
    const [row] = await activities(f);
    await f.t.mutation(internal.liveActivity.checkProof, { activityId: row!._id });
    await settle(f.t);
    expect(alertsSent()).toHaveLength(1);
  });

  test("a report between scheduling and running stops the check from sending", async () => {
    const { f } = await started();
    await settle(f.t, PROOF_WAIT_MS - 10_000);
    await proveStarts(f);
    const [row] = await activities(f);
    await f.t.mutation(internal.liveActivity.checkProof, { activityId: row!._id });
    await settle(f.t, 20_000);
    expect(alertsSent()).toEqual([]);
    expect((await phonePushRow(f))!.blindSince).toBeUndefined();
  });

  test("a report that arrives after the check clears the blind mark", async () => {
    const { f } = await started();
    await settle(f.t, PROOF_WAIT_MS + 10_000);
    expect((await phonePushRow(f))!.blindSince).toBeDefined();
    await proveStarts(f);
    expect((await phonePushRow(f))!.blindSince).toBeUndefined();
    expect((await activities(f))[0]!.phase).toMatchObject({ kind: "started", proof: "proven" });
    await settle(f.t, MIN);
    expect(alertsSent()).toHaveLength(1);
  });
});

describe("a blind phone", () => {
  test("gets its next task's cue as a notification, until it reports again", async () => {
    const f = await setup();
    await reportStartToken(f);
    await pills(f);
    const drops = await addTask(f, { title: "Eye drops", time: "08:10" });
    const walk = await addTask(f, { title: "Short walk", time: "08:20", type: "routine" });
    await tick(f, EIGHT);
    await settle(f.t, PROOF_WAIT_MS + 10_000);
    expect(alertsSent().map((alert) => alert.title)).toEqual(["Morning pills"]);

    await tick(f, EIGHT + 10 * MIN);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    expect(alertsSent().map((alert) => alert.title)).toEqual(["Morning pills", "Eye drops"]);
    expect(await outbox(f, drops)).toEqual([
      expect.objectContaining({ state: "sent", channel: "apns" }),
    ]);

    expect((await putPushState(f, {})).status).toBe(200);
    await tick(f, EIGHT + 20 * MIN);
    await settle(f.t);
    expect(starts().map((aps) => aps.alert.title)).toEqual(["Morning pills", "Short walk"]);
    expect(await outbox(f, walk)).toEqual([
      expect.objectContaining({ state: "sent", channel: "live_activity" }),
    ]);
  });
});

describe("the 4 KB limit of a push", () => {
  function bytes(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  test.each([
    ["three-byte characters", "\u8a9e"],
    ["control characters, which JSON writes as six bytes each", "\u0001"],
  ])("a task at every length limit in %s still fits its start and its update", async (_n, char) => {
    const f = await setup();
    await reportStartToken(f);
    const text = (length: number) => char.repeat(length);
    const instanceId = await addTask(f, {
      title: text(60),
      time: "08:00",
      type: "routine",
      spokenPrompt: text(300),
      screenSentence: text(60),
      pillDescription: text(200),
      checklistItems: Array.from({ length: 50 }, () => text(200)),
    });
    await tick(f, EIGHT);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    await putPushState(f, {
      activities: (await activities(f)).map((row) => ({
        key: row._id,
        token: UPDATE_TOKEN,
        state: "active",
      })),
    });
    const response = await postConfirm(f, await displayToken(f), {
      instanceId,
      pressedAgoMs: 0,
      via: "button",
      step: 0,
    });
    expect(((await response.json()) as { status: string }).status).toBe("advanced");
    await settle(f.t);

    expect(activityPushes().map((push) => (push.payload.aps as StartAps).event)).toEqual([
      "start",
      "update",
    ]);
    for (const push of activityPushes()) {
      expect(bytes(push.message.body)).toBeLessThanOrEqual(4096);
    }
    expect(alertsSent()).toEqual([]);
  });
});

describe("a start token that two phone rows reported", () => {
  const SECOND_ALERT_TOKEN = "f6".repeat(32);

  test("a phone paired again takes the token, and one task starts one activity on it", async () => {
    const old = await setup();
    await reportStartToken(old);
    const paired = await secondPhone(old, SECOND_ALERT_TOKEN);
    await reportStartToken(paired);
    const instanceId = await pills(old);
    await tick(old, EIGHT);
    await settle(old.t);

    expect(activityPushes().map((push) => push.tokens)).toEqual([[START_TOKEN]]);
    expect((await phonePushRow(old))!.liveActivityStart).toBeUndefined();
    expect((await phonePushRow(paired, paired.phoneId))!.liveActivityStart!.token).toBe(
      START_TOKEN,
    );
    expect((await activities(old)).map((row) => row.deviceId)).toEqual([paired.phoneId]);
    expect(alertsSent().map((alert) => alert.tokens)).toEqual([[ALERT_TOKEN]]);
    expect((await outbox(paired, instanceId)).map((row) => row.channel)).toEqual(["live_activity"]);
  });

  test("a phone in another household that reports the token stops the first household's starts", async () => {
    const t = makePhoneBackend();
    const first = await phoneHousehold(t);
    const other = await phoneHousehold(t, "other-");
    await reportStartToken(first);
    await reportStartToken(other);
    const instanceId = await pills(first);
    await tick(first, EIGHT);
    await settle(t);

    expect(activityPushes()).toEqual([]);
    expect((await phonePushRow(first))!.liveActivityStart).toBeUndefined();
    expect((await phonePushRow(other, other.phoneId))!.liveActivityStart!.token).toBe(START_TOKEN);
    expect(await activities(first)).toEqual([]);
    expect(await outbox(first, instanceId)).toEqual([
      expect.objectContaining({ state: "sent", channel: "apns" }),
    ]);
  });
});

describe("the cap on open activities per phone", () => {
  test("a fourth task due together is a notification", async () => {
    const f = await setup();
    await reportStartToken(f);
    const titles = ["Morning pills", "Eye drops", "Inhaler", "Vitamin D"];
    for (const title of titles) await addTask(f, { title, time: "08:00" });
    await tick(f, EIGHT);
    await settle(f.t);
    expect(MAX_OPEN_ACTIVITIES).toBe(3);
    expect(starts()).toHaveLength(3);
    expect(await activities(f)).toHaveLength(3);
    expect(alertsSent()).toHaveLength(1);
    const cued = [...starts().map((aps) => aps.alert.title), ...alertsSent().map((a) => a.title)];
    expect(cued.sort()).toEqual([...titles].sort());
  });

  test("an activity that ended frees a place for the next task", async () => {
    const f = await setup();
    await reportStartToken(f);
    for (const title of ["Morning pills", "Eye drops", "Inhaler"]) {
      await addTask(f, { title, time: "08:00" });
    }
    await addTask(f, { title: "Vitamin D", time: "08:10" });
    await tick(f, EIGHT);
    await settle(f.t);
    const [first, ...rest] = await activities(f);
    await putPushState(f, {
      activities: [
        { key: first!._id, token: null, state: "dismissed" },
        ...rest.map((row) => ({ key: row._id, token: null, state: "active" })),
      ],
    });
    await tick(f, EIGHT + 10 * MIN);
    await settle(f.t);
    expect(starts().map((aps) => aps.alert.title)).toContain("Vitamin D");
    expect(alertsSent()).toEqual([]);
  });
});
