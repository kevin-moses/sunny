import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { alertsSent, resetProviderMocks } from "./deliveryMocks.helpers";
import {
  ALERT_TOKEN,
  MIN,
  UPDATE_TOKEN,
  WIDGET_TOKEN,
  activities,
  activityPushes,
  addTask,
  ends,
  local,
  makePhoneBackend,
  phoneHousehold,
  phonePushRow,
  proveStarts,
  putPushState,
  reportStartToken,
  reportUpdateToken,
  setNow,
  settle,
  starts,
  tick,
} from "./phoneHarness.helpers";
import type { PhoneFixture } from "./phoneHarness.helpers";

vi.mock("./apns", async (original) =>
  (await import("./deliveryMocks.helpers")).apnsModule(await original()),
);

const EIGHT = local("08:00");

beforeEach(() => {
  vi.useFakeTimers();
  setNow(local("07:00"));
  resetProviderMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function twoShown(): Promise<PhoneFixture> {
  const f = await phoneHousehold(makePhoneBackend());
  await reportStartToken(f);
  await putPushState(f, { widgetPush: { token: WIDGET_TOKEN } });
  await addTask(f, { title: "Morning pills", time: "08:00" });
  await tick(f, EIGHT);
  await settle(f.t);
  await reportUpdateToken(f);
  await addTask(f, { title: "Eye drops", time: "08:10" });
  await tick(f, EIGHT + 10 * MIN);
  await settle(f.t);
  await proveStarts(f);
  expect((await activities(f)).map((row) => row.phase.kind)).toEqual(["live", "started"]);
  return f;
}

type Revoke = "removeDevice" | "revokeDeviceToken" | "revokeOwnToken";

async function revoke(f: PhoneFixture, change: Revoke): Promise<void> {
  if (change === "revokeOwnToken") {
    await f.t.withIdentity({ subject: f.phoneUser }).mutation(api.deviceApi.revokeOwnToken, {});
    return;
  }
  await f.t
    .withIdentity({ subject: f.caregiver })
    .mutation(api.households[change], { householdId: f.householdId, deviceId: f.phoneId });
}

describe.each(["removeDevice", "revokeDeviceToken", "revokeOwnToken"] as const)(
  "%s on a phone",
  (change) => {
    test("forgets its push tokens and ends its activities", async () => {
      const f = await twoShown();
      await revoke(f, change);
      await settle(f.t);
      expect(await phonePushRow(f)).toBeNull();
      expect(ends().map((end) => end.tokens)).toEqual([[UPDATE_TOKEN]]);
      expect(ends()[0]!.aps["content-state"].closed).toMatchObject({ kind: "over" });
      expect((await activities(f)).map((row) => row.phase)).toEqual([
        expect.objectContaining({ kind: "ended", reason: "device_revoked" }),
        expect.objectContaining({ kind: "ended", reason: "device_revoked" }),
      ]);
    });

    test("the phone's old device token no longer reports", async () => {
      const f = await twoShown();
      await revoke(f, change);
      const response = await putPushState(f, {});
      expect(response.status).toBe(401);
      expect(await phonePushRow(f)).toBeNull();
    });
  },
);

describe("after a token revoke", () => {
  test("the next cue is a notification until the phone reports with a new token", async () => {
    const f = await twoShown();
    await revoke(f, "revokeDeviceToken");
    await settle(f.t);
    resetProviderMocks();

    await addTask(f, { title: "Inhaler", time: "08:20" });
    await tick(f, EIGHT + 20 * MIN);
    await settle(f.t);
    expect(activityPushes()).toEqual([]);
    expect(alertsSent()).toContainEqual(
      expect.objectContaining({ tokens: [ALERT_TOKEN], title: "Inhaler" }),
    );

    const { deviceToken } = await f.t
      .withIdentity({ subject: f.phoneUser })
      .action(api.deviceApi.issueToken, {});
    await reportStartToken({ ...f, deviceToken });
    await addTask(f, { title: "Vitamin D", time: "08:30" });
    await tick(f, EIGHT + 30 * MIN);
    await settle(f.t);
    expect(starts().map((aps) => aps.alert.title)).toEqual(["Vitamin D"]);
  });
});

describe("after a phone is removed", () => {
  test("later tasks send it nothing", async () => {
    const f = await twoShown();
    await revoke(f, "removeDevice");
    await settle(f.t);
    resetProviderMocks();
    await addTask(f, { title: "Inhaler", time: "08:20" });
    await tick(f, EIGHT + 20 * MIN);
    await settle(f.t);
    expect(activityPushes()).toEqual([]);
    expect(alertsSent()).toEqual([]);
  });
});
