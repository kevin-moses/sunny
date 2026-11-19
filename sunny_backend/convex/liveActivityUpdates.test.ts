import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  APNS_SENT,
  alertsSent,
  answerEachToken,
  providerMocks,
  pushesSent,
  resetProviderMocks,
} from "./deliveryMocks.helpers";
import type { ApnsSendArgs } from "./deliveryMocks.helpers";
import { ACTIVITY_CAP_MS, PROOF_WAIT_MS, RECEIPT_MS } from "./lib/liveActivity";
import { ENDED_KEPT_MS } from "./lib/liveActivitySync";
import {
  ALERT_TOKEN,
  MIN,
  UPDATE_TOKEN,
  WIDGET_TOKEN,
  about,
  activities,
  activity,
  activityPushes,
  addTask,
  backgroundPushes,
  confirmOnDisplay,
  ends,
  insertActivity,
  local,
  makePhoneBackend,
  outbox,
  patchInstance,
  phoneHousehold,
  postConfirm,
  pressOnDisplay,
  proveStarts,
  putPushState,
  reportStartToken,
  reportUpdateToken,
  secondPhone,
  setNow,
  settle,
  starts,
  tick,
  updates,
} from "./phoneHarness.helpers";
import type { ActivityAps, PhoneFixture } from "./phoneHarness.helpers";

vi.mock("./apns", async (original) =>
  (await import("./deliveryMocks.helpers")).apnsModule(await original()),
);

const EIGHT = local("08:00");

const HOUR = 60 * MIN;

const SHOWER_STEPS = ["Turn on the water.", "Wash and rinse.", "Dry off and dress."];

beforeEach(() => {
  vi.useFakeTimers();
  setNow(local("07:00"));
  resetProviderMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Shown {
  f: PhoneFixture;
  instanceId: Id<"taskInstances">;
  activityId: Id<"liveActivities">;
}

async function shownOnPhone(
  spec: Parameters<typeof addTask>[1] = {
    title: "Morning pills",
    time: "08:00",
    screenSentence: "Take your morning pills.",
  },
): Promise<Shown> {
  const f = await phoneHousehold(makePhoneBackend());
  await reportStartToken(f);
  const instanceId = await addTask(f, spec);
  await tick(f, EIGHT);
  await settle(f.t);
  const [row] = await activities(f);
  expect(starts()).toHaveLength(1);
  return { f, instanceId, activityId: row!._id };
}

async function live(spec?: Parameters<typeof addTask>[1]): Promise<Shown> {
  const shown = await shownOnPhone(spec);
  expect(await reportUpdateToken(shown.f)).toEqual([]);
  expect((await activity(shown.f, shown.activityId)).phase.kind).toBe("live");
  return shown;
}

function refuseUpdates(status: number, retryable = false): void {
  answerEachToken((token) =>
    token === UPDATE_TOKEN
      ? {
          outcome: status === 410 ? "unregistered" : "failed",
          status,
          reason: "Refused",
          retryable,
        }
      : APNS_SENT,
  );
}

async function reopen(f: PhoneFixture, instanceId: Id<"taskInstances">): Promise<void> {
  await f.t
    .withIdentity({ subject: f.caregiver })
    .mutation(api.instances.reopenTaskInstance, { instanceId });
}

async function taskIdOf(f: PhoneFixture, instanceId: Id<"taskInstances">): Promise<Id<"tasks">> {
  return await f.t.run(async (ctx) => (await ctx.db.get(instanceId))!.taskId);
}

describe("a task confirmed on another surface", () => {
  test("ends a live activity at once with the final content", async () => {
    const { f, instanceId, activityId } = await live();
    setNow(EIGHT + 4 * MIN);
    await confirmOnDisplay(f, instanceId);
    await settle(f.t);

    const [end] = ends();
    expect(ends()).toHaveLength(1);
    expect(end!.tokens).toEqual([UPDATE_TOKEN]);
    expect(end!.message).toMatchObject({ pushType: "liveactivity", priority: 10 });
    expect(end!.aps["content-state"]).toMatchObject({
      card: { instanceId, label: "Morning pills", step: 0 },
      closed: { kind: "done", at: about(EIGHT + 4 * MIN) },
    });
    expect(end!.aps["dismissal-date"]).toBeLessThan(end!.aps.timestamp);
    expect(end!.aps["stale-date"]).toBeUndefined();
    expect(alertsSent()).toEqual([]);
    const row = await activity(f, activityId);
    expect(row.phase).toMatchObject({ kind: "ended", reason: "confirmed" });
    expect(row.shown.closed).toMatchObject({ kind: "done" });
  });

  test("an activity without an update token ends on the server at once, and the phone is woken to report", async () => {
    const { f, instanceId, activityId } = await shownOnPhone();
    await proveStarts(f);
    resetProviderMocks();
    setNow(EIGHT + 4 * MIN);
    await confirmOnDisplay(f, instanceId);
    await settle(f.t);

    expect(activityPushes()).toEqual([]);
    const row = await activity(f, activityId);
    expect(row.phase).toEqual({ kind: "ended", at: about(EIGHT + 4 * MIN), reason: "confirmed" });
    expect(row.shown.closed).toEqual({ kind: "done", at: about(EIGHT + 4 * MIN) });
    expect(backgroundPushes().map((push) => push.tokens)).toEqual([[ALERT_TOKEN]]);

    const response = await putPushState(f, {
      activities: [{ key: activityId, token: UPDATE_TOKEN, state: "active" }],
    });
    expect(((await response.json()) as { activities: unknown[] }).activities).toEqual([
      {
        key: activityId,
        directive: "end",
        content: expect.objectContaining({ closed: { kind: "done", at: about(EIGHT + 4 * MIN) } }),
      },
    ]);
    await settle(f.t);
    expect(ends()).toEqual([]);
  });

  test("a phone with a widget token is woken as well, because a WidgetKit push runs no app code", async () => {
    const { f, instanceId } = await shownOnPhone();
    expect((await putPushState(f, { widgetPush: { token: WIDGET_TOKEN } })).status).toBe(200);
    await proveStarts(f);
    resetProviderMocks();
    await confirmOnDisplay(f, instanceId);
    await settle(f.t);
    expect(
      pushesSent()
        .map((push) => [push.message.pushType, push.tokens])
        .sort(),
    ).toEqual([
      ["background", [ALERT_TOKEN]],
      ["widgets", [WIDGET_TOKEN]],
    ]);
  });

  test("the wake is sent at once inside the ten minutes that hold back a widget refresh", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    await reportStartToken(f);
    const first = await addTask(f, { title: "Morning pills", time: "08:00" });
    const second = await addTask(f, { title: "Eye drops", time: "08:00" });
    await tick(f, EIGHT);
    await settle(f.t);
    await proveStarts(f);
    resetProviderMocks();

    setNow(EIGHT + 2 * MIN);
    await confirmOnDisplay(f, first);
    await settle(f.t);
    expect(backgroundPushes()).toHaveLength(1);
    setNow(EIGHT + 3 * MIN);
    await confirmOnDisplay(f, second);
    await settle(f.t);
    expect(backgroundPushes()).toHaveLength(2);
    expect((await activities(f)).map((row) => row.phase.kind)).toEqual(["ended", "ended"]);
  });

  test("a press on the phone itself ends its activity without a token and sends it no wake", async () => {
    const { f, instanceId, activityId } = await shownOnPhone();
    await proveStarts(f);
    resetProviderMocks();
    const response = await postConfirm(f, f.deviceToken, {
      instanceId,
      pressedAgoMs: 0,
      via: "widget",
    });
    expect(((await response.json()) as { status: string }).status).toBe("confirmed");
    await settle(f.t);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "confirmed",
    });
    expect(pushesSent()).toEqual([]);
  });

  test("three ended activities without tokens leave room for the next task's start", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    await reportStartToken(f);
    const ids = [];
    for (const title of ["One", "Two", "Three"]) {
      ids.push(await addTask(f, { title, time: "08:00", windowMinutes: 240 }));
    }
    await tick(f, EIGHT);
    await settle(f.t);
    await proveStarts(f);
    setNow(EIGHT + 2 * MIN);
    for (const id of ids) await confirmOnDisplay(f, id);
    await settle(f.t);

    const fourth = await addTask(f, { title: "Four", time: "08:30" });
    await tick(f, EIGHT + 30 * MIN);
    await settle(f.t);
    expect(starts().map((start) => start.alert.title)).toContain("Four");
    expect(alertsSent()).toEqual([]);
    expect((await outbox(f, fourth)).map((row) => row.channel)).toEqual(["live_activity"]);
  });

  test("an activity still waiting for its proof ends when the proof check has run", async () => {
    const { f, instanceId, activityId } = await shownOnPhone();
    await confirmOnDisplay(f, instanceId);
    await settle(f.t);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "started",
      proof: "awaited",
    });
    await settle(f.t, PROOF_WAIT_MS);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "confirmed",
    });
    expect(alertsSent()).toEqual([]);
  });

  test("an end whose retries ran out is sent again by the next tick", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f, instanceId, activityId } = await live();
    refuseUpdates(503, true);
    await confirmOnDisplay(f, instanceId);
    await settle(f.t, MIN);
    expect(ends().length).toBeGreaterThan(1);
    expect((await activity(f, activityId)).phase.kind).toBe("live");

    resetProviderMocks();
    await tick(f, EIGHT + 2 * MIN);
    await settle(f.t);
    expect(ends()).toHaveLength(1);
    expect((await activity(f, activityId)).phase.kind).toBe("ended");
    await tick(f, EIGHT + 3 * MIN);
    await settle(f.t);
    expect(ends()).toHaveLength(1);
    errorSpy.mockRestore();
  });

  test("an end that APNs refuses for good drops the token, ends the row and wakes the phone", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f, instanceId, activityId } = await live();
    expect((await putPushState(f, { widgetPush: { token: WIDGET_TOKEN } })).status).toBe(200);
    resetProviderMocks();
    refuseUpdates(400);
    await confirmOnDisplay(f, instanceId);
    await settle(f.t);
    expect(ends()).toHaveLength(1);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "confirmed",
    });
    expect(backgroundPushes().map((push) => push.tokens)).toEqual([[ALERT_TOKEN]]);

    for (const minute of [2, 3, 4]) {
      await tick(f, EIGHT + minute * MIN);
      await settle(f.t);
    }
    expect(ends()).toHaveLength(1);
    errorSpy.mockRestore();
  });

  test("an update that APNs refuses for good drops the token until the phone reports one again", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f, instanceId, activityId } = await live({
      title: "Shower",
      time: "08:00",
      type: "routine",
      checklistItems: SHOWER_STEPS,
    });
    refuseUpdates(400);
    expect(await pressOnDisplay(f, instanceId, 0)).toBe("advanced");
    await settle(f.t);
    expect(updates()).toHaveLength(1);
    expect((await activity(f, activityId)).phase).toEqual({
      kind: "started",
      acceptedAt: about(EIGHT),
      proof: "proven",
    });
    for (const minute of [2, 3, 4]) {
      await tick(f, EIGHT + minute * MIN);
      await settle(f.t);
    }
    expect(updates()).toHaveLength(1);

    resetProviderMocks();
    expect(await reportUpdateToken(f)).toEqual([
      expect.objectContaining({ key: activityId, directive: "update" }),
    ]);
    await settle(f.t);
    expect(updates().map((update) => update.aps["content-state"].card.step)).toEqual([1]);
    expect((await activity(f, activityId)).phase.kind).toBe("live");
    errorSpy.mockRestore();
  });

  test("a retryable failure is retried by the pool until the end is accepted", async () => {
    const { f, instanceId, activityId } = await live();
    let refusals = 1;
    answerEachToken((token) => {
      if (token !== UPDATE_TOKEN || refusals === 0) return APNS_SENT;
      refusals -= 1;
      return { outcome: "failed", status: 503, reason: "ServiceUnavailable", retryable: true };
    });
    await confirmOnDisplay(f, instanceId);
    await settle(f.t, 20_000);
    expect(ends()).toHaveLength(2);
    expect((await activity(f, activityId)).phase.kind).toBe("ended");
  });

  test("a 410 on the end drops the update token, ends the row and wakes the phone", async () => {
    const { f, instanceId, activityId } = await live();
    expect((await putPushState(f, { widgetPush: { token: WIDGET_TOKEN } })).status).toBe(200);
    resetProviderMocks();
    refuseUpdates(410);
    await confirmOnDisplay(f, instanceId);
    await settle(f.t);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "confirmed",
    });
    expect(backgroundPushes().map((push) => push.tokens)).toEqual([[ALERT_TOKEN]]);
    await tick(f, EIGHT + 2 * MIN);
    await settle(f.t);
    expect(ends()).toHaveLength(1);
  });

  test("a 410 on an update keeps the activity, without a token, while the task is due", async () => {
    const { f, instanceId, activityId } = await live({
      title: "Shower",
      time: "08:00",
      type: "routine",
      checklistItems: SHOWER_STEPS,
    });
    refuseUpdates(410);
    expect(await pressOnDisplay(f, instanceId, 0)).toBe("advanced");
    await settle(f.t);
    expect((await activity(f, activityId)).phase).toEqual({
      kind: "started",
      acceptedAt: about(EIGHT),
      proof: "proven",
    });
  });
});

describe("a multi-step task", () => {
  const shower = {
    title: "Shower",
    time: "08:00",
    type: "routine" as const,
    checklistItems: SHOWER_STEPS,
  };

  test("a step taken elsewhere updates the activity to the next step", async () => {
    const { f, instanceId, activityId } = await live(shower);
    expect(await pressOnDisplay(f, instanceId, 0)).toBe("advanced");
    await settle(f.t);

    const [update] = updates();
    expect(updates()).toHaveLength(1);
    expect(update!.tokens).toEqual([UPDATE_TOKEN]);
    expect(update!.message.expiresAt).toBe((EIGHT + HOUR) / 1000);
    expect(update!.aps).toEqual({
      timestamp: expect.closeTo((EIGHT + 5_000) / 1000, 0),
      event: "update",
      "content-state": {
        card: expect.objectContaining({ step: 1, stepCount: 3, stepText: SHOWER_STEPS[1] }),
        nextSteps: [SHOWER_STEPS[2]],
        closed: null,
      },
      "stale-date": (EIGHT + HOUR) / 1000,
    });
    const row = await activity(f, activityId);
    expect(row.phase.kind).toBe("live");
    expect(row.shown.card.step).toBe(1);
    expect(ends()).toEqual([]);

    await tick(f, EIGHT + MIN);
    await settle(f.t);
    expect(updates()).toHaveLength(1);
  });

  test("the last step ends it", async () => {
    const { f, instanceId, activityId } = await live(shower);
    for (const step of [0, 1]) {
      await pressOnDisplay(f, instanceId, step);
      await settle(f.t);
    }
    expect(await pressOnDisplay(f, instanceId, 2)).toBe("confirmed");
    await settle(f.t);
    expect(updates().map((update) => update.aps["content-state"].card.step)).toEqual([1, 2]);
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.aps["content-state"].card.step).toBe(2);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "confirmed",
    });
  });
});

describe("the receipt after Done is pressed on the activity itself", () => {
  const SECOND_ALERT_TOKEN = "f6".repeat(32);

  const SECOND_UPDATE_TOKEN = "b9".repeat(80);

  async function pressOnPhone(
    f: PhoneFixture,
    instanceId: Id<"taskInstances">,
    via: "live_activity" | "widget",
  ): Promise<void> {
    const response = await postConfirm(f, f.deviceToken, { instanceId, pressedAgoMs: 0, via });
    expect(((await response.json()) as { status: string }).status).toBe("confirmed");
  }

  test("the end push to that phone dismisses the activity ten seconds after the press", async () => {
    const { f, instanceId } = await live();
    setNow(EIGHT + 4 * MIN);
    await pressOnPhone(f, instanceId, "live_activity");
    await settle(f.t);
    const [end] = ends();
    expect(ends()).toHaveLength(1);
    expect(end!.aps["content-state"].closed).toEqual({ kind: "done", at: about(EIGHT + 4 * MIN) });
    expect(end!.aps["dismissal-date"]).toBe((EIGHT + 4 * MIN + RECEIPT_MS) / 1000);
    expect(end!.aps["dismissal-date"]).toBeGreaterThan(end!.aps.timestamp);
  });

  test("a press on the same phone's widget dismisses the activity at once", async () => {
    const { f, instanceId } = await live();
    setNow(EIGHT + 4 * MIN);
    await pressOnPhone(f, instanceId, "widget");
    await settle(f.t);
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.aps["dismissal-date"]).toBeLessThan(ends()[0]!.aps.timestamp);
  });

  test("another phone that shows the task is dismissed at once", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    const other = await secondPhone(f, SECOND_ALERT_TOKEN);
    await reportStartToken(f);
    expect(
      (
        await putPushState(other, {
          liveActivityStart: { token: "7c".repeat(80), enabled: true },
        })
      ).status,
    ).toBe(200);
    const instanceId = await addTask(f, { title: "Morning pills", time: "08:00" });
    await tick(f, EIGHT);
    await settle(f.t);
    for (const row of await activities(f)) {
      const mine = row.deviceId === f.phoneId;
      const response = await putPushState(mine ? f : other, {
        activities: [
          { key: row._id, token: mine ? UPDATE_TOKEN : SECOND_UPDATE_TOKEN, state: "active" },
        ],
      });
      expect(response.status).toBe(200);
    }
    setNow(EIGHT + 4 * MIN);
    await pressOnPhone(f, instanceId, "live_activity");
    await settle(f.t);

    const dismissals = new Map(ends().map((end) => [end.tokens[0], end.aps["dismissal-date"]]));
    expect(ends()).toHaveLength(2);
    expect(dismissals.get(UPDATE_TOKEN)).toBe((EIGHT + 4 * MIN + RECEIPT_MS) / 1000);
    expect(dismissals.get(SECOND_UPDATE_TOKEN)).toBeLessThan((EIGHT + 4 * MIN) / 1000);
  });
});

describe("the order of the pushes to one activity", () => {
  const shower = {
    title: "Shower",
    time: "08:00",
    type: "routine" as const,
    checklistItems: SHOWER_STEPS,
  };

  function isUpdate(args: ApnsSendArgs): boolean {
    const { aps } = JSON.parse(args.sends[0]!.message.body) as { aps: ActivityAps };
    return aps.event === "update";
  }

  test("two updates in one second carry different timestamps, the later one larger", async () => {
    const { f, instanceId } = await live(shower);
    setNow(EIGHT + MIN);
    expect(await pressOnDisplay(f, instanceId, 0)).toBe("advanced");
    setNow(EIGHT + MIN + 400);
    expect(await pressOnDisplay(f, instanceId, 1)).toBe("advanced");
    await settle(f.t);
    const [first, second] = updates().map((update) => update.aps.timestamp);
    expect(updates()).toHaveLength(2);
    expect(first).toBe((EIGHT + MIN) / 1000);
    expect(second).toBe(first! + 1);
  });

  test("an update in the same second as the start carries a larger timestamp", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    await reportStartToken(f);
    const instanceId = await addTask(f, shower);
    await tick(f, EIGHT);
    await settle(f.t, 300);
    expect(starts().map((start) => start.timestamp)).toEqual([EIGHT / 1000]);
    expect(await reportUpdateToken(f)).toEqual([]);
    expect(await pressOnDisplay(f, instanceId, 0)).toBe("advanced");
    await settle(f.t, 300);
    expect(Date.now()).toBeLessThan(EIGHT + 1_000);
    expect(updates().map((update) => update.aps.timestamp)).toEqual([EIGHT / 1000 + 1]);
  });

  test("an update answered after a newer one does not replace what the phone shows", async () => {
    const { f, instanceId, activityId } = await live(shower);
    let overtaken = false;
    providerMocks.apnsSend.mockImplementation(async (args: ApnsSendArgs) => {
      if (!overtaken && isUpdate(args)) {
        overtaken = true;
        await patchInstance(f, instanceId, { currentStep: 2 });
        await f.t.action(internal.liveActivity.push, { activityId });
      }
      return args.sends.map(({ token }) => ({ token, ...APNS_SENT }));
    });
    setNow(EIGHT + MIN);
    expect(await pressOnDisplay(f, instanceId, 0)).toBe("advanced");
    await settle(f.t);

    const sent = updates().map((update) => ({
      step: update.aps["content-state"].card.step,
      timestamp: update.aps.timestamp,
    }));
    expect(sent.map((update) => update.step)).toEqual([1, 2]);
    expect(sent[1]!.timestamp).toBeGreaterThan(sent[0]!.timestamp);
    expect((await activity(f, activityId)).shown.card.step).toBe(2);

    await tick(f, EIGHT + 2 * MIN);
    await settle(f.t);
    expect(updates()).toHaveLength(2);
  });
});

describe("the window closing", () => {
  test("ends a live activity as over", async () => {
    const { f, activityId } = await live();
    await tick(f, EIGHT + HOUR);
    await settle(f.t);
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.aps["content-state"].closed).toEqual({ kind: "over", at: EIGHT + HOUR });
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "window_closed",
    });
  });

  test("ends an activity the server cannot reach, without a push", async () => {
    const { f, activityId } = await shownOnPhone();
    await proveStarts(f);
    await tick(f, EIGHT + HOUR - MIN);
    expect((await activity(f, activityId)).phase.kind).toBe("started");
    resetProviderMocks();
    await tick(f, EIGHT + HOUR);
    await settle(f.t);
    expect(activityPushes()).toEqual([]);
    expect((await activity(f, activityId)).phase).toEqual({
      kind: "ended",
      at: EIGHT + HOUR,
      reason: "window_closed",
    });
    expect(backgroundPushes()).toEqual([]);
  });

  test("a phone that still shows it afterwards is told to end it", async () => {
    const { f, activityId } = await shownOnPhone();
    await proveStarts(f);
    await tick(f, EIGHT + HOUR);
    const response = await putPushState(f, {
      activities: [{ key: activityId, token: null, state: "stale" }],
    });
    expect(((await response.json()) as { activities: unknown[] }).activities).toEqual([
      expect.objectContaining({ key: activityId, directive: "end" }),
    ]);
  });
});

describe("a window longer than the system's eight hours", () => {
  const long = {
    title: "Drink water",
    time: "08:00",
    type: "routine" as const,
    windowMinutes: 720,
  };

  test("a live activity is ended at 7 hours 50 minutes and is not restarted", async () => {
    const { f, activityId } = await live(long);
    expect(starts()[0]!["stale-date"]).toBeCloseTo((EIGHT + ACTIVITY_CAP_MS) / 1000, -1);
    await tick(f, EIGHT + ACTIVITY_CAP_MS - MIN);
    await settle(f.t);
    expect(ends()).toEqual([]);
    await tick(f, EIGHT + ACTIVITY_CAP_MS + MIN);
    await settle(f.t);
    expect(ends()).toHaveLength(1);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "expired",
    });
    await tick(f, EIGHT + ACTIVITY_CAP_MS + 2 * MIN);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    expect(await activities(f)).toHaveLength(1);
  });

  test("an activity without a token ends as expired at the same time", async () => {
    const { f, activityId } = await shownOnPhone(long);
    await proveStarts(f);
    await tick(f, EIGHT + ACTIVITY_CAP_MS + MIN);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "expired",
    });
  });

  test("a live activity whose end never gets through is closed after twelve hours", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f, activityId } = await live(long);
    refuseUpdates(503, true);
    await tick(f, EIGHT + 11 * HOUR + 59 * MIN);
    await settle(f.t, 50_000);
    const tried = ends().length;
    expect(tried).toBeGreaterThan(1);
    expect((await activity(f, activityId)).phase.kind).toBe("live");
    await tick(f, EIGHT + 12 * HOUR + MIN);
    await settle(f.t);
    expect(ends()).toHaveLength(tried);
    expect((await activity(f, activityId)).phase.kind).toBe("ended");
    errorSpy.mockRestore();
  });
});

describe("a caregiver's edit while the activity is up", () => {
  test("a new label is pushed as an update", async () => {
    const { f, instanceId, activityId } = await live();
    await f.t.withIdentity({ subject: f.caregiver }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId: await taskIdOf(f, instanceId),
      displayLabel: "Morning tablets",
      screenSentence: "Take your morning tablets.",
    });
    await settle(f.t);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.aps["content-state"].card).toMatchObject({
      label: "Morning tablets",
      sentence: "Take your morning tablets.",
    });
    expect((await activity(f, activityId)).shown.card.label).toBe("Morning tablets");
  });

  test("an edit that changes nothing the phone shows sends nothing", async () => {
    const { f, instanceId } = await live();
    await f.t.withIdentity({ subject: f.caregiver }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId: await taskIdOf(f, instanceId),
      spokenPrompt: "Time for your pills, the small white ones.",
      highPriority: true,
    });
    await settle(f.t);
    expect(activityPushes()).toHaveLength(1);
  });

  test("a task that is stopped ends its activity as gone", async () => {
    const { f, instanceId, activityId } = await live();
    await f.t.withIdentity({ subject: f.caregiver }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId: await taskIdOf(f, instanceId),
      active: false,
    });
    await settle(f.t);
    expect(ends()).toHaveLength(1);
    expect(ends()[0]!.aps["content-state"]).toMatchObject({
      card: { instanceId, label: "Morning pills" },
      closed: { kind: "over" },
    });
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "instance_gone",
    });
  });

  test("a deleted task ends an activity without a token and wakes the phone", async () => {
    const { f, instanceId, activityId } = await shownOnPhone();
    await proveStarts(f);
    resetProviderMocks();
    await f.t.withIdentity({ subject: f.caregiver }).mutation(api.tasks.remove, {
      householdId: f.householdId,
      taskId: await taskIdOf(f, instanceId),
    });
    await settle(f.t);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "instance_gone",
    });
    expect(backgroundPushes().length).toBeGreaterThan(0);
    expect(activityPushes()).toEqual([]);
  });

  test("a task that is deleted ends its activity as gone", async () => {
    const { f, instanceId, activityId } = await live();
    await f.t.withIdentity({ subject: f.caregiver }).mutation(api.tasks.remove, {
      householdId: f.householdId,
      taskId: await taskIdOf(f, instanceId),
    });
    await settle(f.t);
    expect(ends()).toHaveLength(1);
    expect((await activity(f, activityId)).phase).toMatchObject({
      kind: "ended",
      reason: "instance_gone",
    });
  });
});

describe("a task that comes back after it was done", () => {
  test("a reopen starts a new activity whose alert has no sound", async () => {
    const { f, instanceId, activityId } = await live();
    await confirmOnDisplay(f, instanceId);
    await settle(f.t);
    expect((await activity(f, activityId)).phase.kind).toBe("ended");

    setNow(EIGHT + 5 * MIN);
    await reopen(f, instanceId);
    await settle(f.t);
    const [first, second] = starts();
    expect(starts()).toHaveLength(2);
    expect(first!.alert).toHaveProperty("sound", "default");
    expect(second!.alert).toEqual({ title: "Morning pills", body: first!.alert.body });
    const rows = await activities(f);
    expect(rows.map((row) => row.phase.kind)).toEqual(["ended", "started"]);
    expect(second!.attributes.activityKey).toBe(rows[1]!._id);
    expect(second!.attributes.activityKey).not.toBe(activityId);
    expect(alertsSent()).toEqual([]);
    expect((await outbox(f, instanceId)).map((row) => [row.kind, row.state, row.channel])).toEqual([
      ["senior_prompt", "sent", "live_activity"],
      ["senior_reshow", "sent", "live_activity"],
    ]);
  });

  test("a phone where no Live Activity can start gets nothing, as before", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    const instanceId = await addTask(f, { title: "Morning pills", time: "08:00" });
    await tick(f, EIGHT);
    await settle(f.t);
    expect(alertsSent()).toHaveLength(1);
    await confirmOnDisplay(f, instanceId);
    await reopen(f, instanceId);
    await settle(f.t);
    expect(alertsSent()).toHaveLength(1);
    expect(activityPushes()).toEqual([]);
    expect((await outbox(f, instanceId)).map((row) => [row.kind, row.state, row.detail])).toEqual([
      ["senior_prompt", "sent", undefined],
      ["senior_reshow", "skipped", "no_live_activity"],
    ]);
  });

  test("a task done and reopened ends the activity without a token and starts a quiet new one", async () => {
    const { f, instanceId, activityId } = await shownOnPhone();
    await proveStarts(f);
    await confirmOnDisplay(f, instanceId);
    await reopen(f, instanceId);
    await settle(f.t);
    expect(starts()).toHaveLength(2);
    expect(starts()[1]!.alert).not.toHaveProperty("sound");
    const rows = await activities(f);
    expect(rows.map((row) => row.phase.kind)).toEqual(["ended", "started"]);
    const response = await putPushState(f, {
      activities: rows.map((row) => ({ key: row._id, token: null, state: "active" })),
    });
    expect(((await response.json()) as { activities: unknown[] }).activities).toEqual([
      expect.objectContaining({ key: activityId, directive: "end" }),
    ]);
  });

  test("an activity that is still up when its task is reopened is not started a second time", async () => {
    const { f, instanceId } = await shownOnPhone();
    await confirmOnDisplay(f, instanceId);
    await reopen(f, instanceId);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    expect(await activities(f)).toHaveLength(1);
  });

  test("a task confirmed early and reopened is opened by its own due cue, with sound", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    await reportStartToken(f);
    const instanceId = await addTask(f, { title: "Morning pills", time: "08:00" });
    setNow(EIGHT - 20 * MIN);
    const early = await postConfirm(f, f.deviceToken, {
      instanceId,
      pressedAgoMs: 0,
      via: "widget",
    });
    expect(((await early.json()) as { status: string }).status).toBe("confirmed");
    setNow(EIGHT + 5 * MIN);
    await reopen(f, instanceId);
    await settle(f.t);
    expect(starts()).toEqual([]);
    await tick(f, EIGHT + 6 * MIN);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    expect(starts()[0]!.alert.sound).toBe("default");
  });

  test("a swiped-away activity does not come back for the same task", async () => {
    const { f, instanceId, activityId } = await live();
    await putPushState(f, { activities: [{ key: activityId, token: null, state: "dismissed" }] });
    await tick(f, EIGHT + 15 * MIN);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    expect(alertsSent()).toEqual([
      expect.objectContaining({ title: "Morning pills", interruptionLevel: "time-sensitive" }),
    ]);
    expect((await outbox(f, instanceId)).map((row) => row.channel)).toEqual([
      "live_activity",
      "apns",
    ]);
  });
});

describe("the tick's sweep", () => {
  test("ends a start whose cue row is gone or settled", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    const instanceId = await addTask(f, { title: "Morning pills", time: "08:00" });
    const outboxId = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("notificationOutbox", {
          householdId: f.householdId,
          kind: "senior_prompt",
          taskInstanceId: instanceId,
          recipientDeviceId: f.phoneId,
          title: "Morning pills",
          body: "Time for Morning pills.",
          payload: {},
          state: "failed",
        }),
    );
    const settled = await insertActivity(f, instanceId, { kind: "starting", outboxId, since: 1 });
    await tick(f, local("07:30"));
    expect((await activity(f, settled)).phase).toMatchObject({
      kind: "ended",
      reason: "start_failed",
    });
  });

  test("deletes ended rows after seven days and keeps younger ones", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    const instanceId = await addTask(f, { title: "Morning pills", time: "08:00" });
    const now = local("07:30");
    const old = await insertActivity(f, instanceId, {
      kind: "ended",
      at: now - ENDED_KEPT_MS,
      reason: "confirmed",
    });
    const young = await insertActivity(f, instanceId, {
      kind: "ended",
      at: now - ENDED_KEPT_MS + MIN,
      reason: "confirmed",
    });
    await tick(f, now);
    expect((await activities(f)).map((row) => row._id)).toEqual([young]);
    expect(old).not.toBe(young);
  });
});
