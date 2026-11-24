import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { pushesSent, resetProviderMocks } from "./deliveryMocks.helpers";
import {
  WIDGET_TOKEN,
  addTask,
  local,
  makePhoneBackend,
  outbox,
  phoneHousehold,
  putPushState,
  reportStartToken,
  setNow,
  settle,
  starts,
  tick,
} from "./phoneHarness.helpers";

const SLOW_IMPORT_MS = 300;

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

vi.mock("./apns", async (original) => {
  await new Promise((resolve) => realSetTimeout(resolve, SLOW_IMPORT_MS));
  return (await import("./deliveryMocks.helpers")).apnsModule(await original());
});

const EIGHT = local("08:00");

beforeEach(() => {
  vi.useFakeTimers();
  setNow(local("07:00"));
  resetProviderMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the phone harness", () => {
  test("two deliveries that need the mocked APNs module at once both reach the mock", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    await reportStartToken(f);
    const instanceId = await addTask(f, { title: "Morning pills", time: "08:00" });
    await tick(f, EIGHT);
    await settle(f.t);
    expect(starts()).toHaveLength(1);
    expect(await outbox(f, instanceId)).toEqual([
      expect.objectContaining({ state: "sent", channel: "live_activity" }),
    ]);
  });

  test("settle stops at the instant asked for and leaves later work unrun", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    expect((await putPushState(f, { widgetPush: { token: WIDGET_TOKEN } })).status).toBe(200);
    await f.t.run(async (ctx) => {
      await ctx.scheduler.runAfter(300, internal.phonePush.refreshWidgets, {
        deviceId: f.phoneId,
      });
    });
    const from = Date.now();
    await settle(f.t, 250);
    expect(Date.now()).toBe(from + 250);
    expect(pushesSent()).toEqual([]);
    await settle(f.t, 100);
    expect(Date.now()).toBe(from + 350);
    expect(pushesSent().map((push) => push.tokens)).toEqual([[WIDGET_TOKEN]]);
  });

  test("settle crosses a gap of hours and runs what is due inside it", async () => {
    const f = await phoneHousehold(makePhoneBackend());
    expect((await putPushState(f, { widgetPush: { token: WIDGET_TOKEN } })).status).toBe(200);
    const hours = 60 * 60_000;
    await f.t.run(async (ctx) => {
      await ctx.scheduler.runAfter(11 * hours, internal.phonePush.refreshWidgets, {
        deviceId: f.phoneId,
      });
    });
    const from = Date.now();
    await settle(f.t, 12 * hours);
    expect(Date.now()).toBe(from + 12 * hours);
    expect(pushesSent().map((push) => push.tokens)).toEqual([[WIDGET_TOKEN]]);
  });
});
