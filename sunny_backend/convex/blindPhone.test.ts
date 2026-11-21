import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  APNS_SENT,
  alertsSent,
  answerEachToken,
  providerMocks,
  resetProviderMocks,
} from "./deliveryMocks.helpers";
import type { SentAlert } from "./deliveryMocks.helpers";
import { PROOF_WAIT_MS } from "./lib/liveActivity";
import {
  MIN,
  about,
  addTask,
  local,
  makePhoneBackend,
  phoneHousehold,
  phonePushRow,
  putPushState,
  reportStartToken,
  setNow,
  settle,
  starts,
  tick,
} from "./phoneHarness.helpers";
import type { PhoneFixture } from "./phoneHarness.helpers";
import { setPhone } from "./testing.helpers";

vi.mock("./apns", async (original) =>
  (await import("./deliveryMocks.helpers")).apnsModule(await original()),
);
vi.mock("./lib/twilio", async (original) =>
  (await import("./deliveryMocks.helpers")).twilioModule(await original()),
);

const faults = vi.hoisted(() => ({ blindNotice: false }));

vi.mock("./lib/delivery", async (original) => {
  const real = await original<typeof import("./lib/delivery")>();
  const insertNotification: typeof real.insertNotification = async (ctx, row) => {
    if (faults.blindNotice && row.kind === "lock_screen_blind") {
      throw new Error("blind notice failed");
    }
    return await real.insertNotification(ctx, row);
  };
  return { ...real, insertNotification };
});

const HOUR = 60 * MIN;

const DAY_TWO = "2026-11-14";

const PAT_TOKEN = "b1".repeat(32);

const VAL_TOKEN = "b2".repeat(32);

const SAM_TOKEN = "b3".repeat(32);

const TITLE = "Mom's phone is not showing tasks on its Lock Screen";

const BODY =
  "Open Sunny on that phone, and check in Settings that Live Activities are switched on for Sunny.";

beforeEach(() => {
  faults.blindNotice = false;
  vi.useFakeTimers();
  setNow(local("07:00"));
  resetProviderMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function joinAs(
  f: PhoneFixture,
  userId: string,
  grants: "caregiver_member" | "caregiver_viewer",
) {
  const { code } = await f.t
    .withIdentity({ subject: f.caregiver })
    .mutation(api.households.createJoinCode, { householdId: f.householdId, grants });
  await f.t.withIdentity({ subject: userId }).mutation(api.households.redeemJoinCode, { code });
}

async function family(): Promise<PhoneFixture> {
  const f = await phoneHousehold(makePhoneBackend());
  await joinAs(f, "sam", "caregiver_member");
  await joinAs(f, "val", "caregiver_viewer");
  await f.t.run(async (ctx) => {
    await ctx.db.insert("pushTokens", { userId: f.caregiver, token: PAT_TOKEN });
    await ctx.db.insert("pushTokens", { userId: "val", token: VAL_TOKEN });
  });
  await setPhone(f.t, f.householdId, f.caregiver, "+15555550101");
  await setPhone(f.t, f.householdId, "sam", "+15555550102");
  await reportStartToken(f);
  return f;
}

async function goBlind(
  f: PhoneFixture,
  title: string,
  time: string,
  date?: string,
): Promise<number> {
  const startsBefore = starts().length;
  await tick(f, local(time, date));
  await settle(f.t, PROOF_WAIT_MS + 10_000);
  expect(
    starts()
      .map((aps) => aps.alert.title)
      .slice(startsBefore),
  ).toEqual([title]);
  const { blindSince } = (await phonePushRow(f))!;
  expect(blindSince).toBeDefined();
  return blindSince!;
}

async function blindFamily(): Promise<{ f: PhoneFixture; blindAt: number }> {
  const f = await family();
  await addTask(f, { title: "Morning pills", time: "08:00" });
  return { f, blindAt: await goBlind(f, "Morning pills", "08:00") };
}

async function sweep(f: PhoneFixture, at: number): Promise<void> {
  setNow(at);
  await f.t.mutation(internal.phonePush.sweepBlindPhones, { now: at });
  await settle(f.t);
}

function notices(): SentAlert[] {
  return alertsSent().filter((alert) => alert.data.kind === "lock_screen_blind");
}

async function noticeRows(f: PhoneFixture) {
  return await f.t.run(async (ctx) =>
    (await ctx.db.query("notificationOutbox").collect()).filter(
      (row) => row.kind === "lock_screen_blind",
    ),
  );
}

async function setPaused(f: PhoneFixture, backgroundPaused: boolean): Promise<void> {
  await f.t
    .withIdentity({ subject: f.caregiver })
    .mutation(api.households.update, { householdId: f.householdId, backgroundPaused });
}

async function listedBlindSince(f: PhoneFixture): Promise<number | null> {
  const devices = await f.t
    .withIdentity({ subject: f.caregiver })
    .query(api.households.listDevices, { householdId: f.householdId });
  return devices.find((device) => device._id === f.phoneId)!.lockScreenBlindSince;
}

describe("a phone whose Lock Screen stopped showing tasks", () => {
  test("blind for 23 hours 59 minutes tells nobody", async () => {
    const { f, blindAt } = await blindFamily();
    await sweep(f, blindAt + 24 * HOUR - MIN);
    expect(notices()).toEqual([]);
    expect(await noticeRows(f)).toEqual([]);
  });

  test("at 24 hours each caregiver with a push token gets one plain notice and nobody a text", async () => {
    const { f, blindAt } = await blindFamily();
    providerMocks.smsSend.mockClear();
    await sweep(f, blindAt + 24 * HOUR);
    const told = notices();
    expect(told.map((alert) => alert.tokens).sort()).toEqual([[PAT_TOKEN], [VAL_TOKEN]]);
    for (const alert of told) {
      expect(alert).toEqual({
        tokens: alert.tokens,
        title: TITLE,
        body: BODY,
        data: expect.objectContaining({ kind: "lock_screen_blind", household_id: f.householdId }),
      });
    }
    const rows = await noticeRows(f);
    expect(rows.map((row) => row.recipientUserId).sort()).toEqual([f.caregiver, "val"]);
    expect(rows.every((row) => row.state === "sent" && row.channel === "apns")).toBe(true);
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
  });

  test("a later tick in the same blind stretch tells nobody again", async () => {
    const { f, blindAt } = await blindFamily();
    await sweep(f, blindAt + 24 * HOUR);
    await sweep(f, blindAt + 24 * HOUR + MIN);
    await sweep(f, blindAt + 48 * HOUR);
    expect(notices()).toHaveLength(2);
    expect(await noticeRows(f)).toHaveLength(2);
  });

  test("a report ends the stretch, and a new 24-hour stretch tells each caregiver once more", async () => {
    const { f, blindAt } = await blindFamily();
    await addTask(f, { title: "Eye drops", time: "09:00" });
    await sweep(f, blindAt + 24 * HOUR);
    expect(notices()).toHaveLength(2);

    expect((await putPushState(f, {})).status).toBe(200);
    const cleared = (await phonePushRow(f))!;
    expect(cleared.blindSince).toBeUndefined();
    expect(cleared.blindToldAt).toBeUndefined();
    expect(await listedBlindSince(f)).toBeNull();

    const blindAgainAt = await goBlind(f, "Eye drops", "09:00", DAY_TWO);
    expect(await listedBlindSince(f)).toBe(blindAgainAt);
    await sweep(f, blindAgainAt + 24 * HOUR - MIN);
    expect(notices()).toHaveLength(2);
    await sweep(f, blindAgainAt + 24 * HOUR);
    expect(notices()).toHaveLength(4);
    expect(
      notices()
        .slice(2)
        .map((alert) => alert.tokens)
        .sort(),
    ).toEqual([[PAT_TOKEN], [VAL_TOKEN]]);
  });

  test("a refused push token is not followed by a text", async () => {
    const { f, blindAt } = await blindFamily();
    answerEachToken((token) =>
      token === PAT_TOKEN
        ? { outcome: "unregistered", status: 410, reason: "Unregistered", retryable: false }
        : APNS_SENT,
    );
    providerMocks.smsSend.mockClear();
    await sweep(f, blindAt + 24 * HOUR);
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    const pats = (await noticeRows(f)).filter((row) => row.recipientUserId === f.caregiver);
    expect(pats).toEqual([expect.objectContaining({ state: "skipped" })]);
  });

  test("a second unproven start keeps the time the stretch began", async () => {
    const f = await family();
    await addTask(f, { title: "Morning pills", time: "08:00" });
    await tick(f, local("08:00"));
    await settle(f.t, 30_000);
    await addTask(f, { title: "Eye drops", time: "08:00" });
    await tick(f, local("08:00") + 30_000);
    await settle(f.t, PROOF_WAIT_MS + 30_000);
    expect(starts().map((aps) => aps.alert.title)).toEqual(["Morning pills", "Eye drops"]);
    expect((await phonePushRow(f))!.blindSince).toEqual(about(local("08:00") + PROOF_WAIT_MS));
  });

  test("caregivers see since when the Lock Screen is blind", async () => {
    const f = await family();
    expect(await listedBlindSince(f)).toBeNull();
    await addTask(f, { title: "Morning pills", time: "08:00" });
    const blindAt = await goBlind(f, "Morning pills", "08:00");
    expect(await listedBlindSince(f)).toBe(blindAt);
  });
});

describe("a blind notice that fails", () => {
  test("leaves the medication tick running, and the due prompt goes out", async () => {
    const { f, blindAt } = await blindFamily();
    faults.blindNotice = true;
    const alertsBefore = alertsSent().length;
    const at = blindAt + 24 * HOUR;
    setNow(at);
    await expect(f.t.mutation(internal.phonePush.sweepBlindPhones, { now: at })).rejects.toThrow(
      "blind notice failed",
    );
    await f.t.mutation(internal.scheduler.tick, { now: at });
    await settle(f.t);
    const prompts = alertsSent()
      .slice(alertsBefore)
      .filter((alert) => alert.data.kind === "senior_prompt");
    expect(prompts.map((alert) => alert.title)).toEqual(["Morning pills"]);
    expect(await noticeRows(f)).toEqual([]);
  });
});

describe("a notice that cannot go out yet", () => {
  test("a notice still waiting when the phone reports is skipped", async () => {
    const { f, blindAt } = await blindFamily();
    setNow(blindAt + 24 * HOUR);
    await f.t.mutation(internal.phonePush.sweepBlindPhones, { now: blindAt + 24 * HOUR });
    expect((await noticeRows(f)).map((row) => row.state)).toEqual(["pending", "pending"]);
    expect((await putPushState(f, {})).status).toBe(200);
    await settle(f.t);
    expect(notices()).toEqual([]);
    expect(await noticeRows(f)).toEqual([
      expect.objectContaining({ state: "skipped", detail: "phone_not_blind" }),
      expect.objectContaining({ state: "skipped", detail: "phone_not_blind" }),
    ]);
  });

  test("with no caregiver who has a push token the stretch stays untold, and a caregiver who installs the app later is told", async () => {
    const { f, blindAt } = await blindFamily();
    await f.t.run(async (ctx) => {
      for (const row of await ctx.db.query("pushTokens").collect()) {
        if (row.userId !== f.phoneUser) await ctx.db.delete(row._id);
      }
    });
    await sweep(f, blindAt + 24 * HOUR);
    await sweep(f, blindAt + 30 * HOUR);
    expect(await noticeRows(f)).toEqual([]);
    expect((await phonePushRow(f))!.blindToldAt).toBeUndefined();

    await f.t.run(async (ctx) => {
      await ctx.db.insert("pushTokens", { userId: "sam", token: SAM_TOKEN });
    });
    await sweep(f, blindAt + 31 * HOUR);
    expect(notices().map((alert) => alert.tokens)).toEqual([[SAM_TOKEN]]);
    expect((await phonePushRow(f))!.blindToldAt).toBe(blindAt + 31 * HOUR);
    await sweep(f, blindAt + 32 * HOUR);
    expect(notices()).toHaveLength(1);
  });

  test("a paused household is told nothing until the pause ends, then once if the phone is still blind", async () => {
    const { f, blindAt } = await blindFamily();
    await setPaused(f, true);
    await sweep(f, blindAt + 24 * HOUR);
    await sweep(f, blindAt + 40 * HOUR);
    expect(await noticeRows(f)).toEqual([]);
    expect((await phonePushRow(f))!.blindToldAt).toBeUndefined();

    await setPaused(f, false);
    await sweep(f, blindAt + 41 * HOUR);
    expect(
      notices()
        .map((alert) => alert.tokens)
        .sort(),
    ).toEqual([[PAT_TOKEN], [VAL_TOKEN]]);
    await sweep(f, blindAt + 42 * HOUR);
    expect(notices()).toHaveLength(2);
  });

  test("a phone that reported during the pause is not reported after it", async () => {
    const { f, blindAt } = await blindFamily();
    await setPaused(f, true);
    await sweep(f, blindAt + 24 * HOUR);
    expect((await putPushState(f, {})).status).toBe(200);
    await setPaused(f, false);
    await sweep(f, blindAt + 25 * HOUR);
    expect(await noticeRows(f)).toEqual([]);
  });
});

describe.each(["revokeDeviceToken", "removeDevice"] as const)("after %s", (change) => {
  test("the blind phone is not reported", async () => {
    const { f, blindAt } = await blindFamily();
    await f.t
      .withIdentity({ subject: f.caregiver })
      .mutation(api.households[change], { householdId: f.householdId, deviceId: f.phoneId });
    await sweep(f, blindAt + 24 * HOUR);
    expect(notices()).toEqual([]);
    expect(await noticeRows(f)).toEqual([]);
  });
});
