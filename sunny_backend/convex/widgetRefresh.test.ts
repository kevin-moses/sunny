import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { answerEachToken, pushesSent, resetProviderMocks } from "./deliveryMocks.helpers";
import type { SentPush } from "./deliveryMocks.helpers";
import { WIDGET_REFRESH_GAP_MS } from "./lib/widgetRefresh";
import {
  ALERT_TOKEN,
  DAY,
  MIN,
  WIDGET_TOKEN,
  addTask,
  local,
  makePhoneBackend,
  patchInstance,
  phoneHousehold,
  phonePushRow,
  postConfirm,
  pressOnDisplay,
  putPushState,
  secondPhone,
  setNow,
  settle,
  tick,
} from "./phoneHarness.helpers";
import type { PhoneFixture } from "./phoneHarness.helpers";

vi.mock("./apns", async (original) =>
  (await import("./deliveryMocks.helpers")).apnsModule(await original()),
);

const EIGHT = local("08:00");

const T0 = EIGHT + 5 * MIN;

const SECOND_ALERT_TOKEN = "a7".repeat(32);

const FIVE_STEPS = ["Fill the kettle.", "Boil it.", "Warm the pot.", "Add the tea.", "Pour."];

beforeEach(() => {
  vi.useFakeTimers();
  setNow(local("07:00"));
  resetProviderMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function refreshes(): SentPush[] {
  return pushesSent().filter(
    (push) => push.message.pushType === "widgets" || push.message.pushType === "background",
  );
}

async function dueTea(f: PhoneFixture): Promise<Id<"taskInstances">> {
  const instanceId = await addTask(f, {
    title: "Make tea",
    time: "08:00",
    type: "routine",
    checklistItems: FIVE_STEPS,
  });
  await patchInstance(f, instanceId, { state: "due" });
  await settle(f.t);
  return instanceId;
}

async function reporting(report: unknown): Promise<PhoneFixture> {
  const f = await phoneHousehold(makePhoneBackend());
  expect((await putPushState(f, report)).status).toBe(200);
  return f;
}

async function atGapStart(f: PhoneFixture): Promise<Id<"taskInstances">> {
  const instanceId = await dueTea(f);
  setNow(T0 - WIDGET_REFRESH_GAP_MS);
  await f.t.run(async (ctx) => {
    const row = (await ctx.db.query("phonePush").first())!;
    await ctx.db.patch(row._id, { widgetRefresh: undefined });
  });
  resetProviderMocks();
  setNow(T0);
  return instanceId;
}

describe("a change the phone's timeline could not predict", () => {
  test("sends a WidgetKit push at once to a phone that reported a widget token", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    const instanceId = await atGapStart(f);
    expect(await pressOnDisplay(f, instanceId, 0)).toBe("advanced");
    await settle(f.t);
    expect(refreshes()).toEqual([
      {
        tokens: [WIDGET_TOKEN],
        message: {
          pushType: "widgets",
          priority: 10,
          expiresAt: 0,
          body: '{"aps":{"content-changed":true}}',
        },
        payload: { aps: { "content-changed": true } },
      },
    ]);
  });

  test("sends a background push to the alert token of a phone without a widget token", async () => {
    const f = await reporting({});
    const instanceId = await atGapStart(f);
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    expect(refreshes()).toEqual([
      {
        tokens: [ALERT_TOKEN],
        message: {
          pushType: "background",
          priority: 5,
          expiresAt: 0,
          body: '{"aps":{"content-available":1}}',
        },
        payload: { aps: { "content-available": 1 } },
      },
    ]);
  });

  test("sends nothing to a phone that never reported", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    const instanceId = await dueTea(f);
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    expect(refreshes()).toEqual([]);
  });

  test("a caregiver's task edit and a new task also ask for a refresh", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    await addTask(f, { title: "Morning pills", time: "08:00" });
    await settle(f.t);
    expect(refreshes()).toHaveLength(1);
  });
});

describe("a calendar change, which moves the widget's Next line", () => {
  async function forgetLastRefresh(f: PhoneFixture): Promise<void> {
    await settle(f.t);
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("phonePush").first())!;
      await ctx.db.patch(row._id, { widgetRefresh: undefined });
    });
    resetProviderMocks();
  }

  async function withWidget(): Promise<PhoneFixture> {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    setNow(T0);
    return f;
  }

  async function addVisit(f: PhoneFixture): Promise<Id<"events">> {
    const event = await f.t.withIdentity({ subject: f.caregiver }).mutation(api.calendar.addEvent, {
      householdId: f.householdId,
      title: "Anna visits",
      onDate: DAY,
      startTime: "15:00",
    });
    return event.eventId;
  }

  function widgetPushes(): string[][] {
    return refreshes().map((push) => push.tokens);
  }

  test("a new event asks for a refresh", async () => {
    const f = await withWidget();
    await addVisit(f);
    await settle(f.t);
    expect(widgetPushes()).toEqual([[WIDGET_TOKEN]]);
  });

  test("an edited event asks for a refresh, and an edit that changes nothing does not", async () => {
    const f = await withWidget();
    const eventId = await addVisit(f);
    await forgetLastRefresh(f);
    const pat = f.t.withIdentity({ subject: f.caregiver });
    await pat.mutation(api.calendar.updateEvent, {
      householdId: f.householdId,
      eventId,
      changes: { startTime: "16:00" },
    });
    await settle(f.t);
    expect(widgetPushes()).toEqual([[WIDGET_TOKEN]]);

    await forgetLastRefresh(f);
    await pat.mutation(api.calendar.updateEvent, {
      householdId: f.householdId,
      eventId,
      changes: { startTime: "16:00" },
    });
    await settle(f.t);
    expect(widgetPushes()).toEqual([]);
  });

  test("a cancelled event asks for a refresh", async () => {
    const f = await withWidget();
    const eventId = await addVisit(f);
    await forgetLastRefresh(f);
    await f.t
      .withIdentity({ subject: f.caregiver })
      .mutation(api.calendar.cancelEvent, { householdId: f.householdId, eventId });
    await settle(f.t);
    expect(widgetPushes()).toEqual([[WIDGET_TOKEN]]);
  });

  test("a new household timezone asks for a refresh, and other settings do not", async () => {
    const f = await withWidget();
    const pat = f.t.withIdentity({ subject: f.caregiver });
    await pat.mutation(api.households.update, {
      householdId: f.householdId,
      timezone: "America/Chicago",
    });
    await settle(f.t);
    expect(widgetPushes()).toEqual([[WIDGET_TOKEN]]);

    await forgetLastRefresh(f);
    await pat.mutation(api.households.update, {
      householdId: f.householdId,
      timezone: "America/Chicago",
      digestTime: "18:30",
    });
    await settle(f.t);
    expect(widgetPushes()).toEqual([]);
  });

  test("two event changes inside ten minutes send one push at once and fold the second", async () => {
    const f = await withWidget();
    const eventId = await addVisit(f);
    await f.t
      .withIdentity({ subject: f.caregiver })
      .mutation(api.calendar.cancelEvent, { householdId: f.householdId, eventId });
    await settle(f.t);
    expect(widgetPushes()).toEqual([[WIDGET_TOKEN]]);
    expect((await phonePushRow(f))!.widgetRefresh).toEqual({
      sentAt: expect.closeTo(T0, -2),
      trailingAt: expect.closeTo(T0 + WIDGET_REFRESH_GAP_MS, -2),
    });
  });
});

describe("the ten-minute throttle", () => {
  test("three more changes inside the window fold into one trailing send", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    const instanceId = await atGapStart(f);
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    expect(refreshes()).toHaveLength(1);

    for (const step of [1, 2, 3]) {
      await settle(f.t, MIN);
      expect(await pressOnDisplay(f, instanceId, step)).toBe("advanced");
    }
    await settle(f.t);
    expect(refreshes()).toHaveLength(1);
    expect((await phonePushRow(f))!.widgetRefresh).toEqual({
      sentAt: expect.closeTo(T0, -2),
      trailingAt: expect.closeTo(T0 + WIDGET_REFRESH_GAP_MS, -2),
    });

    await settle(f.t, T0 + WIDGET_REFRESH_GAP_MS - MIN - Date.now());
    expect(refreshes()).toHaveLength(1);

    await settle(f.t, 2 * MIN);
    expect(refreshes()).toHaveLength(2);
    expect(refreshes()[1]!.tokens).toEqual([WIDGET_TOKEN]);
    expect((await phonePushRow(f))!.widgetRefresh).toEqual({
      sentAt: expect.closeTo(T0 + WIDGET_REFRESH_GAP_MS, -3),
      trailingAt: null,
    });

    await settle(f.t, 2 * WIDGET_REFRESH_GAP_MS);
    expect(refreshes()).toHaveLength(2);
  });

  test("a change after the trailing send waits for its own gap", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    const instanceId = await atGapStart(f);
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t, MIN);
    await pressOnDisplay(f, instanceId, 1);
    await settle(f.t, WIDGET_REFRESH_GAP_MS);
    expect(refreshes()).toHaveLength(2);

    await pressOnDisplay(f, instanceId, 2);
    await settle(f.t, MIN);
    expect(refreshes()).toHaveLength(2);
    await settle(f.t, WIDGET_REFRESH_GAP_MS);
    expect(refreshes()).toHaveLength(3);
  });

  test("a change once the window has passed is sent at once again", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    const instanceId = await atGapStart(f);
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    setNow(T0 + WIDGET_REFRESH_GAP_MS + MIN);
    await pressOnDisplay(f, instanceId, 1);
    await settle(f.t);
    expect(refreshes()).toHaveLength(2);
    expect((await phonePushRow(f))!.widgetRefresh!.trailingAt).toBeNull();
  });
});

describe("who is not sent a refresh", () => {
  test("the phone whose own press made the change gets none; another phone does", async () => {
    const f = await reporting({});
    const other = await secondPhone(f, SECOND_ALERT_TOKEN);
    expect((await putPushState(other, {})).status).toBe(200);
    const instanceId = await atGapStart(f);
    const response = await postConfirm(f, f.deviceToken, {
      instanceId,
      pressedAgoMs: 0,
      via: "widget",
      step: 0,
    });
    expect(((await response.json()) as { status: string }).status).toBe("advanced");
    await settle(f.t);
    expect(refreshes().map((push) => push.tokens)).toEqual([[SECOND_ALERT_TOKEN]]);
  });

  test("a widget token that a phone paired again took gets one push, not two", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    const paired = await secondPhone(f, SECOND_ALERT_TOKEN);
    expect((await putPushState(paired, { widgetPush: { token: WIDGET_TOKEN } })).status).toBe(200);
    const instanceId = await atGapStart(f);
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    expect(
      refreshes()
        .map((push) => [push.message.pushType, push.tokens])
        .sort(),
    ).toEqual([
      ["background", [ALERT_TOKEN]],
      ["widgets", [WIDGET_TOKEN]],
    ]);
  });

  test("changes the scheduler makes send none", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    await addTask(f, { title: "Morning pills", time: "08:00", windowMinutes: 30 });
    await settle(f.t);
    setNow(EIGHT - 30 * MIN);
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("phonePush").first())!;
      await ctx.db.patch(row._id, { widgetRefresh: undefined });
    });
    resetProviderMocks();
    await tick(f, EIGHT);
    await settle(f.t);
    await tick(f, EIGHT + 30 * MIN);
    await settle(f.t);
    expect(refreshes()).toEqual([]);
    expect((await phonePushRow(f))!.widgetRefresh).toBeUndefined();
  });
});

describe("dead refresh tokens", () => {
  test("a 410 deletes the widget token, and the next refresh uses the alert token", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    const instanceId = await atGapStart(f);
    answerEachToken(() => ({
      outcome: "unregistered",
      status: 410,
      reason: "Unregistered",
      retryable: false,
    }));
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    expect((await phonePushRow(f))!.widgetPush).toBeUndefined();

    resetProviderMocks();
    setNow(T0 + WIDGET_REFRESH_GAP_MS + MIN);
    await pressOnDisplay(f, instanceId, 1);
    await settle(f.t);
    expect(refreshes().map((push) => [push.message.pushType, push.tokens])).toEqual([
      ["background", [ALERT_TOKEN]],
    ]);
  });

  test("a 410 on a background push deletes that alert token", async () => {
    const f = await reporting({});
    const instanceId = await atGapStart(f);
    answerEachToken(() => ({
      outcome: "unregistered",
      status: 410,
      reason: "Unregistered",
      retryable: false,
    }));
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    const left = await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(left).toEqual([]);
  });

  test("a BadDeviceToken on a background push keeps the alert token, which the app does not send again", async () => {
    const f = await reporting({});
    const instanceId = await atGapStart(f);
    answerEachToken(() => ({
      outcome: "failed",
      status: 400,
      reason: "BadDeviceToken",
      retryable: false,
    }));
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    const left = await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(left.map((row) => row.token)).toEqual([ALERT_TOKEN]);
  });

  test("a BadDeviceToken on a WidgetKit push deletes the widget token, which the next report brings back", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    const instanceId = await atGapStart(f);
    answerEachToken(() => ({
      outcome: "failed",
      status: 400,
      reason: "BadDeviceToken",
      retryable: false,
    }));
    await pressOnDisplay(f, instanceId, 0);
    await settle(f.t);
    expect((await phonePushRow(f))!.widgetPush).toBeUndefined();
  });

  test("a caregiver's reopen is one of the changes that refresh", async () => {
    const f = await reporting({ widgetPush: { token: WIDGET_TOKEN } });
    const instanceId = await atGapStart(f);
    await patchInstance(f, instanceId, { state: "confirmed", confirmedAt: T0 - MIN });
    await f.t
      .withIdentity({ subject: f.caregiver })
      .mutation(api.instances.reopenTaskInstance, { instanceId });
    await settle(f.t);
    expect(refreshes()).toHaveLength(1);
  });
});
