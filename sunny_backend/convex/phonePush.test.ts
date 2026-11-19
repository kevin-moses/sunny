import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { REPORT_GRACE_MS } from "./lib/liveActivity";
import {
  MIN,
  START_TOKEN,
  UPDATE_TOKEN,
  WIDGET_TOKEN,
  about,
  activity,
  addTask,
  displayToken,
  insertActivity,
  local,
  makePhoneBackend,
  patchInstance,
  phoneHousehold,
  phonePushRow,
  putPushState,
  secondPhone,
  setNow,
} from "./phoneHarness.helpers";
import type { PhoneFixture } from "./phoneHarness.helpers";
import { MAX_REPORTED_ACTIVITIES, parsePushStateRequest } from "./phonePush";

const EIGHT = local("08:00");

const OTHER_TOKEN = "f6".repeat(80);

const SECOND_ALERT_TOKEN = "a7".repeat(32);

beforeEach(() => {
  vi.useFakeTimers();
  setNow(EIGHT + 5 * MIN);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(): Promise<PhoneFixture> {
  return await phoneHousehold(makePhoneBackend());
}

async function pills(f: PhoneFixture): Promise<Id<"taskInstances">> {
  const instanceId = await addTask(f, {
    title: "Morning pills",
    time: "08:00",
    screenSentence: "Take your morning pills.",
  });
  await patchInstance(f, instanceId, { state: "due" });
  return instanceId;
}

async function directives(response: Response): Promise<unknown[]> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { activities: unknown[] }).activities;
}

describe("parsePushStateRequest", () => {
  test("an empty report is valid and has no sections", () => {
    expect(parsePushStateRequest({})).toEqual({});
  });

  test("a full report is read as sent", () => {
    const report = {
      liveActivityStart: { token: START_TOKEN, enabled: true },
      activities: [
        { key: "k1", token: UPDATE_TOKEN, state: "active" },
        { key: "k2", token: null, state: "dismissed" },
      ],
      widgetPush: { token: null },
    };
    expect(parsePushStateRequest(report)).toEqual(report);
  });

  test.each([
    ["an unknown section", { pushToken: "x" }, /Unknown field pushToken/],
    ["a start section that is not an object", { liveActivityStart: START_TOKEN }, /object/],
    ["a start section without enabled", { liveActivityStart: { token: null } }, /enabled/],
    [
      "a start section with an extra key",
      { liveActivityStart: { token: null, enabled: true, more: 1 } },
      /Unknown field more/,
    ],
    [
      "a start token that is not hex",
      { liveActivityStart: { token: "not-a-token", enabled: true } },
      /hex push token/,
    ],
    [
      "an enabled flag that is not a boolean",
      { liveActivityStart: { token: null, enabled: "yes" } },
      /boolean/,
    ],
    ["activities that are not a list", { activities: {} }, /list/],
    [
      "too many activities",
      {
        activities: Array.from({ length: MAX_REPORTED_ACTIVITIES + 1 }, (_, n) => ({
          key: `k${n}`,
          token: null,
          state: "active",
        })),
      },
      /at most 8/,
    ],
    ["an activity without a key", { activities: [{ token: null, state: "active" }] }, /key/],
    ["an empty key", { activities: [{ key: "", token: null, state: "active" }] }, /activityKey/],
    [
      "a key that is too long",
      { activities: [{ key: "k".repeat(65), token: null, state: "active" }] },
      /activityKey/,
    ],
    [
      "an activity token that is not hex",
      { activities: [{ key: "k", token: 12, state: "active" }] },
      /hex push token/,
    ],
    [
      "an unknown activity state",
      { activities: [{ key: "k", token: null, state: "paused" }] },
      /active, stale, ended, dismissed/,
    ],
    ["a widget section without a token", { widgetPush: {} }, /token/],
    ["a widget token that is not hex", { widgetPush: { token: "zz" } }, /hex push token/],
  ])("%s is refused", (_name, body, message) => {
    expect(parsePushStateRequest(body)).toMatch(message);
  });
});

describe("PUT /device/push-state", () => {
  test("a request without a device token gets 401 and stores nothing", async () => {
    const f = await setup();
    const response = await putPushState(
      f,
      { liveActivityStart: { token: START_TOKEN, enabled: true } },
      null,
    );
    expect(response.status).toBe(401);
    expect(await phonePushRow(f)).toBeNull();
  });

  test("the home display is refused with 403", async () => {
    const f = await setup();
    const response = await putPushState(
      f,
      { liveActivityStart: { token: START_TOKEN, enabled: true } },
      await displayToken(f),
    );
    expect(response.status).toBe(403);
    expect(await phonePushRow(f, f.displayId)).toBeNull();
  });

  test.each([
    ["text that is not JSON", "not json"],
    ["an unknown field", { deviceToken: "x" }],
    ["a bad token", { widgetPush: { token: "abc" } }],
  ])("%s gets 400 and stores nothing", async (_name, body) => {
    const f = await setup();
    const response = await putPushState(f, body);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await phonePushRow(f)).toBeNull();
  });

  test("the start token is stored with the time it was reported", async () => {
    const f = await setup();
    const response = await putPushState(f, {
      liveActivityStart: { token: START_TOKEN, enabled: true },
    });
    expect(await directives(response)).toEqual([]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await phonePushRow(f)).toMatchObject({
      deviceId: f.phoneId,
      liveActivityStart: { token: START_TOKEN, reportedAt: about(EIGHT + 5 * MIN) },
    });
  });

  test("a newer start token replaces the stored one", async () => {
    const f = await setup();
    await putPushState(f, { liveActivityStart: { token: START_TOKEN, enabled: true } });
    await putPushState(f, { liveActivityStart: { token: OTHER_TOKEN, enabled: true } });
    expect((await phonePushRow(f))!.liveActivityStart!.token).toBe(OTHER_TOKEN);
  });

  test.each([
    ["Live Activities turned off", { token: START_TOKEN, enabled: false }],
    ["no token", { token: null, enabled: true }],
  ])("a start section with %s clears the stored token", async (_name, liveActivityStart) => {
    const f = await setup();
    await putPushState(f, { liveActivityStart: { token: START_TOKEN, enabled: true } });
    await putPushState(f, { liveActivityStart });
    expect((await phonePushRow(f))!.liveActivityStart).toBeUndefined();
  });

  test("a section that is absent changes nothing", async () => {
    const f = await setup();
    await putPushState(f, {
      liveActivityStart: { token: START_TOKEN, enabled: true },
      widgetPush: { token: WIDGET_TOKEN },
    });
    await putPushState(f, {});
    expect(await phonePushRow(f)).toMatchObject({
      liveActivityStart: { token: START_TOKEN },
      widgetPush: { token: WIDGET_TOKEN },
    });
    await putPushState(f, { widgetPush: { token: null } });
    const row = (await phonePushRow(f))!;
    expect(row.widgetPush).toBeUndefined();
    expect(row.liveActivityStart!.token).toBe(START_TOKEN);
  });

  test("a start token another phone reports later leaves the first phone's row", async () => {
    const f = await setup();
    const later = await secondPhone(f, SECOND_ALERT_TOKEN);
    await putPushState(f, {
      liveActivityStart: { token: START_TOKEN, enabled: true },
      widgetPush: { token: WIDGET_TOKEN },
    });
    await putPushState(later, { liveActivityStart: { token: START_TOKEN, enabled: true } });
    const first = (await phonePushRow(f))!;
    expect(first.liveActivityStart).toBeUndefined();
    expect(first.widgetPush!.token).toBe(WIDGET_TOKEN);
    expect((await phonePushRow(later, later.phoneId))!.liveActivityStart!.token).toBe(START_TOKEN);
  });

  test("a widget token another phone reports later leaves the first phone's row", async () => {
    const f = await setup();
    const later = await secondPhone(f, SECOND_ALERT_TOKEN);
    await putPushState(f, {
      liveActivityStart: { token: START_TOKEN, enabled: true },
      widgetPush: { token: WIDGET_TOKEN },
    });
    await putPushState(later, { widgetPush: { token: WIDGET_TOKEN } });
    const first = (await phonePushRow(f))!;
    expect(first.widgetPush).toBeUndefined();
    expect(first.liveActivityStart!.token).toBe(START_TOKEN);
    expect((await phonePushRow(later, later.phoneId))!.widgetPush!.token).toBe(WIDGET_TOKEN);
  });

  test("a phone that reports its own tokens again keeps them", async () => {
    const f = await setup();
    const report = {
      liveActivityStart: { token: START_TOKEN, enabled: true },
      widgetPush: { token: WIDGET_TOKEN },
    };
    await putPushState(f, report);
    await putPushState(f, report);
    expect(await phonePushRow(f)).toMatchObject({
      liveActivityStart: { token: START_TOKEN },
      widgetPush: { token: WIDGET_TOKEN },
    });
  });

  test("any report, even an empty one, clears the blind mark", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("phonePush", { deviceId: f.phoneId, blindSince: EIGHT });
    });
    expect(await directives(await putPushState(f, {}))).toEqual([]);
    expect((await phonePushRow(f))!.blindSince).toBeUndefined();
  });
});

describe("reported activities", () => {
  const accepted = EIGHT + MIN;

  async function report(
    f: PhoneFixture,
    key: string,
    state: string,
    token: string | null = null,
  ): Promise<unknown[]> {
    return await directives(await putPushState(f, { activities: [{ key, token, state }] }));
  }

  test("an update token makes a started activity live, with nothing to apply", async () => {
    const f = await setup();
    const id = await insertActivity(f, await pills(f), {
      kind: "started",
      acceptedAt: accepted,
      proof: "awaited",
    });
    expect(await report(f, id, "active", UPDATE_TOKEN)).toEqual([]);
    expect((await activity(f, id)).phase).toEqual({
      kind: "live",
      acceptedAt: accepted,
      updateToken: UPDATE_TOKEN,
    });
  });

  test("a report without a token proves the start and keeps it started", async () => {
    const f = await setup();
    const id = await insertActivity(f, await pills(f), {
      kind: "started",
      acceptedAt: accepted,
      proof: "missed",
    });
    expect(await report(f, id, "stale")).toEqual([]);
    expect((await activity(f, id)).phase).toEqual({
      kind: "started",
      acceptedAt: accepted,
      proof: "proven",
    });
  });

  test("a report that arrives before APNs answered accepts the start", async () => {
    const f = await setup();
    const outboxId = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("notificationOutbox", {
          householdId: f.householdId,
          kind: "senior_prompt",
          recipientDeviceId: f.phoneId,
          title: "Morning pills",
          body: "Time for Morning pills.",
          payload: {},
          state: "pending",
        }),
    );
    const id = await insertActivity(f, await pills(f), {
      kind: "starting",
      outboxId,
      since: accepted,
    });
    await report(f, id, "active");
    expect((await activity(f, id)).phase).toEqual({
      kind: "started",
      acceptedAt: about(EIGHT + 5 * MIN),
      proof: "proven",
    });
  });

  test("a live activity that reports a new token gets it stored", async () => {
    const f = await setup();
    const id = await insertActivity(f, await pills(f), {
      kind: "live",
      acceptedAt: accepted,
      updateToken: UPDATE_TOKEN,
    });
    await report(f, id, "active", OTHER_TOKEN);
    expect((await activity(f, id)).phase).toMatchObject({ kind: "live", updateToken: OTHER_TOKEN });
    await report(f, id, "active");
    expect((await activity(f, id)).phase).toMatchObject({ kind: "live", updateToken: OTHER_TOKEN });
  });

  test.each(["ended", "dismissed"])(
    "an activity reported %s on the phone is ended and gets no directive",
    async (state) => {
      const f = await setup();
      const id = await insertActivity(f, await pills(f), {
        kind: "live",
        acceptedAt: accepted,
        updateToken: UPDATE_TOKEN,
      });
      expect(await report(f, id, state)).toEqual([]);
      expect((await activity(f, id)).phase).toEqual({
        kind: "ended",
        at: about(EIGHT + 5 * MIN),
        reason: "ended_on_phone",
      });
    },
  );

  test("a task confirmed elsewhere tells the phone to end, with the final content", async () => {
    const f = await setup();
    const instanceId = await pills(f);
    const id = await insertActivity(f, instanceId, {
      kind: "started",
      acceptedAt: accepted,
      proof: "awaited",
    });
    const confirmedAt = EIGHT + 3 * MIN;
    await patchInstance(f, instanceId, { state: "confirmed", confirmedAt });
    expect(await report(f, id, "active")).toEqual([
      {
        key: id,
        directive: "end",
        content: {
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
          closed: { kind: "done", at: confirmedAt },
        },
      },
    ]);
    expect((await activity(f, id)).phase).toMatchObject({ kind: "ended", reason: "confirmed" });
    expect((await activity(f, id)).shown.closed).toEqual({ kind: "done", at: confirmedAt });
    expect(await report(f, id, "ended")).toEqual([]);
    expect((await activity(f, id)).phase).toMatchObject({ kind: "ended", reason: "confirmed" });
  });

  test("a step taken elsewhere tells the phone to update to the current step", async () => {
    const f = await setup();
    const instanceId = await addTask(f, {
      title: "Shower",
      time: "08:00",
      type: "routine",
      checklistItems: ["Turn on the water.", "Wash and rinse.", "Dry off and dress."],
    });
    await patchInstance(f, instanceId, { state: "due" });
    const id = await insertActivity(f, instanceId, {
      kind: "started",
      acceptedAt: accepted,
      proof: "proven",
    });
    await patchInstance(f, instanceId, { currentStep: 1 });
    expect(await report(f, id, "active")).toEqual([
      {
        key: id,
        directive: "update",
        staleAt: EIGHT + 60 * MIN,
        content: expect.objectContaining({
          card: expect.objectContaining({ step: 1, stepCount: 3, stepText: "Wash and rinse." }),
          nextSteps: ["Dry off and dress."],
          closed: null,
        }),
      },
    ]);
  });

  test("an ended activity that the phone still shows is told to end again", async () => {
    const f = await setup();
    const id = await insertActivity(f, await pills(f), {
      kind: "ended",
      at: accepted,
      reason: "window_closed",
    });
    const [directive] = (await report(f, id, "stale")) as { directive: string; key: string }[];
    expect(directive).toMatchObject({ key: id, directive: "end" });
    expect((await activity(f, id)).phase).toMatchObject({ kind: "ended", reason: "window_closed" });
    expect(await report(f, id, "dismissed")).toEqual([]);
  });

  test("a key the server does not know is told to end without content", async () => {
    const f = await setup();
    expect(await report(f, "not-an-activity", "active")).toEqual([
      { key: "not-an-activity", directive: "end", content: null },
    ]);
    expect(await report(f, "not-an-activity", "ended")).toEqual([]);
  });

  test("another phone's activity is answered like an unknown key and left alone", async () => {
    const f = await setup();
    const other = await phoneHousehold(f.t, "other-");
    const instanceId = await addTask(other, { title: "Evening pills", time: "08:00" });
    const phase = { kind: "started" as const, acceptedAt: accepted, proof: "awaited" as const };
    const id = await insertActivity(other, instanceId, phase);
    expect(await report(f, id, "active", UPDATE_TOKEN)).toEqual([
      { key: id, directive: "end", content: null },
    ]);
    expect(await report(f, id, "ended")).toEqual([]);
    expect((await activity(other, id)).phase).toEqual(phase);
  });

  describe("an open activity the phone does not list", () => {
    async function unlisted(f: PhoneFixture, acceptedAt: number): Promise<Id<"liveActivities">> {
      return await insertActivity(f, await pills(f), {
        kind: "live",
        acceptedAt,
        updateToken: UPDATE_TOKEN,
      });
    }

    test("is ended once a minute has passed since its start was accepted", async () => {
      const f = await setup();
      const id = await unlisted(f, Date.now() - REPORT_GRACE_MS);
      await putPushState(f, { activities: [] });
      expect((await activity(f, id)).phase).toMatchObject({
        kind: "ended",
        reason: "ended_on_phone",
      });
    });

    test("is left alone inside that minute", async () => {
      const f = await setup();
      const id = await unlisted(f, Date.now() - REPORT_GRACE_MS + 1_000);
      await putPushState(f, { activities: [] });
      expect((await activity(f, id)).phase.kind).toBe("live");
    });

    test("is left alone by a report without the activities section", async () => {
      const f = await setup();
      const id = await unlisted(f, accepted - 30 * MIN);
      await putPushState(f, { liveActivityStart: { token: START_TOKEN, enabled: true } });
      expect((await activity(f, id)).phase.kind).toBe("live");
    });
  });
});
