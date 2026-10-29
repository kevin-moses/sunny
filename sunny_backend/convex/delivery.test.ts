// delivery.test.ts
// Purpose: Tests for notification delivery (delivery.ts, lib/delivery.ts). APNs and SMS are
// mocked (deliveryMocks.helpers.ts); the delivery action runs directly through t.action, and
// one test runs it through the workpool. Covers: routing per kind and recipient (device -> APNs
// with task_instance_id, member -> SMS to the verified phone, title and body combined, the
// caregiver_alert reply hint); token cleanup; skipped rows (no tokens, unverified or missing
// phone, device removed, recipient left the household, no recipient, stale content); retryable
// versus permanent failures for both channels; configuration errors not retried; settled and
// missing rows left alone; the attempt cap; the completion handler; the sweeper; and insertion
// through insertNotification being delivered end to end.
//
// Last modified: 2026-10-29

import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  deliveryFixture,
  insertOutbox,
  outboxRow,
  providerMocks,
  resetProviderMocks,
} from "./deliveryMocks.helpers";
import type { DeliveryFixture } from "./deliveryMocks.helpers";
import { insertNotification, MAX_ATTEMPTS, STUCK_AFTER_MS } from "./lib/delivery";
import { addInstance, createHousehold, makeBackend } from "./testing.helpers";

vi.mock("./apns", async (original) =>
  (await import("./deliveryMocks.helpers")).apnsModule(await original()),
);
vi.mock("./sms", async (original) =>
  (await import("./deliveryMocks.helpers")).smsModule(await original()),
);

const NOW = Date.parse("2026-11-02T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetProviderMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * purpose: A fresh fixture.
 * @return: (Promise<DeliveryFixture>) The fixture.
 */
async function setup(): Promise<DeliveryFixture> {
  return await deliveryFixture(makeBackend());
}

/**
 * purpose: Run the delivery action for a row.
 * @param f: (DeliveryFixture) Fixture.
 * @param outboxId: (Id<"notificationOutbox">) The row.
 * @return: The outcome.
 */
async function deliver(f: DeliveryFixture, outboxId: Id<"notificationOutbox">) {
  return await f.t.action(internal.delivery.deliver, { outboxId });
}

describe("APNs routing", () => {
  test("a device row is pushed to every token of the device's user", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { kind: "senior_prompt", recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("sent");
    expect(providerMocks.apnsSend).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: ["tok-1", "tok-2"], title: "Title", body: "Body" }),
    );
    expect(await outboxRow(f, id)).toMatchObject({ channel: "apns", attempts: 1 });
    expect((await outboxRow(f, id)).state).toBe("sent");
    expect((await outboxRow(f, id)).settledAt).toBeGreaterThanOrEqual(NOW);
  });

  test("the payload carries task_instance_id when the row has an instance", async () => {
    const f = await setup();
    const taskInstanceId = await addInstance(f.t, f.householdId, "Pills", {
      state: "due",
      localDate: "2026-11-02",
    });
    const id = await insertOutbox(f, {
      kind: "senior_prompt",
      recipientDeviceId: f.deviceId,
      taskInstanceId,
    });
    await deliver(f, id);
    const data = providerMocks.apnsSend.mock.calls[0]![0].data;
    expect(data).toMatchObject({ task_instance_id: taskInstanceId, kind: "senior_prompt" });
  });

  test("the payload has no task_instance_id for a row without an instance", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    await deliver(f, id);
    expect(providerMocks.apnsSend.mock.calls[0]![0].data).not.toHaveProperty("task_instance_id");
  });

  test("unregistered tokens are deleted and the row is still sent", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValue([
      {
        token: "tok-1",
        outcome: "unregistered",
        status: 410,
        reason: "Unregistered",
        retryable: false,
      },
      { token: "tok-2", outcome: "sent", status: 200, reason: null, retryable: false },
    ]);
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("sent");
    const tokens = await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(tokens.map((t) => t.token)).toEqual(["tok-2"]);
  });

  test("when every token is unregistered the tokens go and the row is skipped", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockImplementation(async (args: { tokens: string[] }) =>
      args.tokens.map((token) => ({
        token,
        outcome: "unregistered",
        status: 410,
        reason: "Unregistered",
        retryable: false,
      })),
    );
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("skipped");
    expect(await outboxRow(f, id)).toMatchObject({
      state: "skipped",
      detail: "tokens_unregistered",
    });
    expect(await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect())).toHaveLength(
      0,
    );
  });

  test("a device with no tokens is skipped without calling APNs", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      for (const row of await ctx.db.query("pushTokens").collect()) await ctx.db.delete(row._id);
    });
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("skipped");
    expect(providerMocks.apnsSend).not.toHaveBeenCalled();
    expect(await outboxRow(f, id)).toMatchObject({
      state: "skipped",
      detail: "no_push_tokens",
    });
    expect((await outboxRow(f, id)).settledAt).toBeDefined();
  });

  test("a device that was removed is skipped", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    await f.t.run(async (ctx) => await ctx.db.delete(f.deviceId));
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("device_removed");
    expect(providerMocks.apnsSend).not.toHaveBeenCalled();
  });

  test("a device of another household is never pushed to", async () => {
    const f = await setup();
    const otherHousehold = await createHousehold(f.t, { subject: "zed" });
    const otherDevice = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("devices", {
          householdId: otherHousehold,
          userId: "other-phone",
          kind: "senior_phone",
        }),
    );
    const id = await insertOutbox(f, { recipientDeviceId: otherDevice });
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("device_removed");
  });

  test("a retryable failure throws, keeps the row open and counts the attempt", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValue([
      {
        token: "tok-1",
        outcome: "failed",
        status: 429,
        reason: "TooManyRequests",
        retryable: true,
      },
      {
        token: "tok-2",
        outcome: "failed",
        status: 503,
        reason: "ServiceUnavailable",
        retryable: true,
      },
    ]);
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    await expect(deliver(f, id)).rejects.toThrow(/will retry/);
    const row = await outboxRow(f, id);
    expect(row.state).toBe("pending");
    expect(row).toMatchObject({
      attempts: 1,
      detail: expect.stringContaining("429 TooManyRequests"),
    });

    resetProviderMocks();
    expect(await deliver(f, id)).toBe("sent");
    expect(await outboxRow(f, id)).toMatchObject({ attempts: 2 });
    expect((await outboxRow(f, id)).state).toBe("sent");
  });

  test("a permanent failure settles the row as failed without a retry", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValue([
      {
        token: "tok-1",
        outcome: "failed",
        status: 400,
        reason: "BadDeviceToken",
        retryable: false,
      },
    ]);
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("failed");
    const row = await outboxRow(f, id);
    expect(row).toMatchObject({ state: "failed", detail: "400 BadDeviceToken" });
    expect(row.channel).toBeUndefined();
  });

  test("a configuration result is not retried and fails the row", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValue({
      results: [],
      configError: "APNs is not configured: set APNS_KEY",
    });
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("failed");
    expect(await outboxRow(f, id)).toMatchObject({
      state: "failed",
      detail: "APNs is not configured: set APNS_KEY",
    });
    expect(providerMocks.apnsSend).toHaveBeenCalledTimes(1);
  });

  test("an unexpected error is recorded and rethrown for a retry", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockRejectedValue(new Error("socket hang up"));
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    await expect(deliver(f, id)).rejects.toThrow(/socket hang up/);
    const row = await outboxRow(f, id);
    expect(row.state).toBe("pending");
    expect(row.detail).toMatch(/socket hang up/);
  });
});

describe("SMS routing", () => {
  test("a member row is texted at the verified phone with title and body", async () => {
    const f = await setup();
    const id = await insertOutbox(f, {
      recipientUserId: "pat",
      title: "Today: Physio",
      body: "At 3 PM.",
    });
    expect(await deliver(f, id)).toBe("sent");
    expect(providerMocks.smsSend).toHaveBeenCalledWith({
      to: "+15550000001",
      body: "Today: Physio\nAt 3 PM.",
    });
    expect(await outboxRow(f, id)).toMatchObject({ channel: "sms", attempts: 1 });
    expect((await outboxRow(f, id)).state).toBe("sent");
  });

  test("a caregiver alert gets the reply hint and other kinds do not", async () => {
    const f = await setup();
    const alert = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "pat" });
    const notice = await insertOutbox(f, { kind: "event_notice", recipientUserId: "pat" });
    await deliver(f, alert);
    await deliver(f, notice);
    expect(providerMocks.smsSend.mock.calls[0]![0].body).toBe(
      "Title\nBody\nReply 1 if you're on it.",
    );
    expect(providerMocks.smsSend.mock.calls[1]![0].body).toBe("Title\nBody");
  });

  test("a digest row is texted like any member row", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { kind: "digest", recipientUserId: "max", body: "Line one" });
    await deliver(f, id);
    expect(providerMocks.smsSend).toHaveBeenCalledWith({
      to: "+15550000002",
      body: "Title\nLine one",
    });
  });

  test("a member whose phone is not verified is skipped", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "val" });
    expect(await deliver(f, id)).toBe("skipped");
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    expect(await outboxRow(f, id)).toMatchObject({
      state: "skipped",
      detail: "no_verified_phone",
    });
  });

  test("a member with no phone is skipped", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => {
      const member = (await ctx.db
        .query("householdMembers")
        .withIndex("by_household_user", (q) =>
          q.eq("householdId", f.householdId).eq("userId", "pat"),
        )
        .unique())!;
      await ctx.db.patch(member._id, { phone: undefined });
    });
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("no_verified_phone");
  });

  test("a member who left the household is never texted", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "max" });
    await f.t.run(async (ctx) => {
      const member = (await ctx.db
        .query("householdMembers")
        .withIndex("by_household_user", (q) =>
          q.eq("householdId", f.householdId).eq("userId", "max"),
        )
        .unique())!;
      await ctx.db.delete(member._id);
    });
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("recipient_left");
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
  });

  test("a member of another household is not a recipient", async () => {
    const f = await setup();
    await createHousehold(f.t, { subject: "zed" });
    const id = await insertOutbox(f, { recipientUserId: "zed" });
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("recipient_left");
  });

  test("a retryable SMS failure throws and keeps the row open", async () => {
    const f = await setup();
    providerMocks.smsSend.mockResolvedValue({ ok: false, retryable: true, error: "503 busy" });
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    await expect(deliver(f, id)).rejects.toThrow(/will retry/);
    expect(await outboxRow(f, id)).toMatchObject({
      attempts: 1,
      detail: expect.stringContaining("503 busy"),
    });
    expect((await outboxRow(f, id)).state).toBe("pending");
  });

  test("a permanent SMS failure settles the row as failed", async () => {
    const f = await setup();
    providerMocks.smsSend.mockResolvedValue({
      ok: false,
      retryable: false,
      error: "21211 bad number",
    });
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("failed");
    expect(await outboxRow(f, id)).toMatchObject({ detail: "21211 bad number" });
    expect((await outboxRow(f, id)).state).toBe("failed");
  });

  test("an SMS configuration result is not retried and fails the row", async () => {
    const f = await setup();
    providerMocks.smsSend.mockResolvedValue({
      ok: false,
      retryable: false,
      config: true,
      error: "SMS is not configured: set TWILIO_ACCOUNT_SID",
    });
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("failed");
    expect(await outboxRow(f, id)).toMatchObject({
      state: "failed",
      detail: "SMS is not configured: set TWILIO_ACCOUNT_SID",
    });
    expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
  });
});

describe("other rows", () => {
  test("a row with no recipient is skipped", async () => {
    const f = await setup();
    const id = await insertOutbox(f);
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("no_recipient");
  });

  test("a settled row is not sent again", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    await deliver(f, id);
    expect(await deliver(f, id)).toBe("settled");
    expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
  });

  test("a deleted row ends the job quietly", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    await f.t.run(async (ctx) => await ctx.db.delete(id));
    expect(await deliver(f, id)).toBe("missing");
  });

  test("a row that used up its attempts is failed instead of sent", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "pat", attempts: MAX_ATTEMPTS });
    expect(await deliver(f, id)).toBe("failed");
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    expect((await outboxRow(f, id)).state).toBe("failed");
  });
});

describe("stale content", () => {
  test("a caregiver alert for an instance confirmed meanwhile is skipped", async () => {
    const f = await setup();
    const taskInstanceId = await addInstance(f.t, f.householdId, "Pills", {
      state: "confirmed",
      localDate: "2026-11-02",
    });
    const id = await insertOutbox(f, {
      kind: "caregiver_alert",
      recipientUserId: "pat",
      taskInstanceId,
    });
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("instance_closed");
  });

  test("a caregiver alert for a missed instance is still sent", async () => {
    const f = await setup();
    const taskInstanceId = await addInstance(f.t, f.householdId, "Pills", {
      state: "missed",
      localDate: "2026-11-02",
    });
    const id = await insertOutbox(f, {
      kind: "caregiver_alert",
      recipientUserId: "pat",
      taskInstanceId,
    });
    expect(await deliver(f, id)).toBe("sent");
  });

  test("a senior prompt for an instance that is no longer open is skipped", async () => {
    const f = await setup();
    const taskInstanceId = await addInstance(f.t, f.householdId, "Pills", {
      state: "missed",
      localDate: "2026-11-02",
    });
    const id = await insertOutbox(f, {
      kind: "senior_prompt",
      recipientDeviceId: f.deviceId,
      taskInstanceId,
    });
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("instance_closed");
  });

  test("a row whose instance is gone is skipped", async () => {
    const f = await setup();
    const taskInstanceId = await addInstance(f.t, f.householdId, "Pills", {
      state: "due",
      localDate: "2026-11-02",
    });
    const id = await insertOutbox(f, {
      kind: "senior_prompt",
      recipientDeviceId: f.deviceId,
      taskInstanceId,
    });
    await f.t.run(async (ctx) => await ctx.db.delete(taskInstanceId));
    expect(await deliver(f, id)).toBe("skipped");
    expect((await outboxRow(f, id)).detail).toBe("instance_gone");
  });
});

describe("completion handler", () => {
  const WORK_ID = "work_1" as WorkId;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("a failed run settles an open row as failed with the error", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    await f.t.mutation(internal.delivery.onDeliveryComplete, {
      workId: WORK_ID,
      context: { outboxId: id },
      result: { kind: "failed", error: "retries exhausted" },
    });
    expect(await outboxRow(f, id)).toMatchObject({ detail: "retries exhausted" });
    expect((await outboxRow(f, id)).state).toBe("failed");
    expect((await outboxRow(f, id)).settledAt).toBeGreaterThanOrEqual(NOW);
  });

  test("a failed run does not overwrite a row that was already sent", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    await deliver(f, id);
    await f.t.mutation(internal.delivery.onDeliveryComplete, {
      workId: WORK_ID,
      context: { outboxId: id },
      result: { kind: "failed", error: "late" },
    });
    expect((await outboxRow(f, id)).state).toBe("sent");
  });

  test("success, cancellation and a deleted row change nothing", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    for (const result of [
      { kind: "success" as const, returnValue: "sent" },
      { kind: "canceled" as const },
    ]) {
      await f.t.mutation(internal.delivery.onDeliveryComplete, {
        workId: WORK_ID,
        context: { outboxId: id },
        result,
      });
    }
    expect((await outboxRow(f, id)).state).toBe("pending");
    await f.t.run(async (ctx) => await ctx.db.delete(id));
    await f.t.mutation(internal.delivery.onDeliveryComplete, {
      workId: WORK_ID,
      context: { outboxId: id },
      result: { kind: "failed", error: "x" },
    });
  });
});

describe("sweeper", () => {
  test("re-enqueues only unsettled rows older than the cutoff", async () => {
    const f = await setup();
    const old = await insertOutbox(f, { recipientUserId: "pat" });
    const settled = await insertOutbox(f, {
      recipientUserId: "pat",
      state: "sent",
      settledAt: NOW,
    });
    vi.setSystemTime(NOW + STUCK_AFTER_MS + 1_000);
    const young = await insertOutbox(f, { recipientUserId: "pat" });
    expect(await f.t.mutation(internal.delivery.sweepStuck, {})).toBe(1);
    expect(old).not.toBe(young);
    expect(settled).not.toBe(old);
  });

  test("a swept row is delivered by the workpool", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    vi.setSystemTime(NOW + STUCK_AFTER_MS + 1_000);
    await f.t.mutation(internal.delivery.sweepStuck, {});
    await drivePool(f, id);
    expect((await outboxRow(f, id)).state).toBe("sent");
  });

  test("does nothing when every row is young or settled", async () => {
    const f = await setup();
    await insertOutbox(f, { recipientUserId: "pat" });
    expect(await f.t.mutation(internal.delivery.sweepStuck, {})).toBe(0);
  });
});

/**
 * purpose: Drive the workpool until a row is settled (the same loop the calendar tests use).
 * @param f: (DeliveryFixture) Fixture.
 * @param id: (Id<"notificationOutbox">) The row.
 * @return: (Promise<void>) Resolves when settled or after a bounded number of rounds.
 */
async function drivePool(f: DeliveryFixture, id: Id<"notificationOutbox">): Promise<void> {
  for (let i = 0; i < 100 && (await outboxRow(f, id)).state === "pending"; i++) {
    let finished = false;
    void f.t.finishInProgressScheduledFunctions().then(() => {
      finished = true;
    });
    while (!finished) await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1_100);
  }
}

describe("insertNotification", () => {
  test("a row inserted through the helper is delivered by the workpool", async () => {
    const f = await setup();
    const id = await f.t.run(
      async (ctx) =>
        await insertNotification(ctx, {
          householdId: f.householdId,
          kind: "senior_prompt",
          recipientDeviceId: f.deviceId,
          title: "Pills",
          body: "Time for pills.",
          payload: {},
        }),
    );
    await drivePool(f, id);
    expect(providerMocks.apnsSend).toHaveBeenCalledTimes(1);
    expect(await outboxRow(f, id)).toMatchObject({ channel: "apns" });
    expect((await outboxRow(f, id)).state).toBe("sent");
  });

  test("a retryable failure is retried by the workpool until it succeeds", async () => {
    const f = await setup();
    providerMocks.smsSend
      .mockResolvedValueOnce({ ok: false, retryable: true, error: "503" })
      .mockResolvedValue({ ok: true, sid: "SM2" });
    const id = await f.t.run(
      async (ctx) =>
        await insertNotification(ctx, {
          householdId: f.householdId,
          kind: "event_notice",
          recipientUserId: "pat",
          title: "t",
          body: "b",
          payload: {},
        }),
    );
    await drivePool(f, id);
    expect(providerMocks.smsSend).toHaveBeenCalledTimes(2);
    expect((await outboxRow(f, id)).state).toBe("sent");
    expect((await outboxRow(f, id)).attempts).toBe(2);
  });
});
