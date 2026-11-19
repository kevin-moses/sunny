import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  alertsSent,
  answerEachToken,
  deliveryFixture,
  insertOutbox,
  outboxRow,
  providerMocks,
  resetProviderMocks,
} from "./deliveryMocks.helpers";
import type { DeliveryFixture } from "./deliveryMocks.helpers";
import { insertNotification, MAX_ATTEMPTS, STUCK_AFTER_MS } from "./lib/delivery";
import { addInstance, createHousehold, makeBackend, setPhone } from "./testing.helpers";

vi.mock("./apns", async (original) =>
  (await import("./deliveryMocks.helpers")).apnsModule(await original()),
);
vi.mock("./lib/twilio", async (original) =>
  (await import("./deliveryMocks.helpers")).twilioModule(await original()),
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

async function setup(): Promise<DeliveryFixture> {
  return await deliveryFixture(makeBackend());
}

async function deliver(f: DeliveryFixture, outboxId: Id<"notificationOutbox">) {
  return await f.t.action(internal.delivery.deliver, { outboxId });
}

describe("APNs routing", () => {
  test("a device row is pushed to every token of the device's user", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { kind: "senior_prompt", recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("sent");
    expect(alertsSent()).toEqual([
      expect.objectContaining({ tokens: ["tok-1", "tok-2"], title: "Title", body: "Body" }),
    ]);
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
    const data = alertsSent()[0]!.data;
    expect(data).toMatchObject({ task_instance_id: taskInstanceId, kind: "senior_prompt" });
  });

  test("the payload has no task_instance_id for a row without an instance", async () => {
    const f = await setup();
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    await deliver(f, id);
    expect(alertsSent()[0]!.data).not.toHaveProperty("task_instance_id");
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
    answerEachToken(() => ({
      outcome: "unregistered",
      status: 410,
      reason: "Unregistered",
      retryable: false,
    }));
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
        reason: "BadTopic",
        retryable: false,
      },
    ]);
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("failed");
    const row = await outboxRow(f, id);
    expect(row).toMatchObject({ state: "failed", detail: "400 BadTopic" });
    expect(row.channel).toBeUndefined();
  });

  test("a token APNs refuses as bad is deleted like an unregistered one", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValue([
      {
        token: "tok-1",
        outcome: "failed",
        status: 400,
        reason: "BadDeviceToken",
        retryable: false,
      },
      { token: "tok-2", outcome: "sent", status: 200, reason: null, retryable: false },
    ]);
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("sent");
    const left = await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(left.map((t) => t.token)).toEqual(["tok-2"]);
  });

  test("an alert refused for the provider token is held for a retry, not failed", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValue([
      {
        token: "tok-1",
        outcome: "failed",
        status: 403,
        reason: "ExpiredProviderToken",
        retryable: false,
      },
      {
        token: "tok-2",
        outcome: "failed",
        status: 403,
        reason: "ExpiredProviderToken",
        retryable: false,
      },
    ]);
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("config");
    expect(await outboxRow(f, id)).toMatchObject({
      state: "pending",
      detail: "403 ExpiredProviderToken",
    });
    expect(await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect())).toHaveLength(
      2,
    );
    resetProviderMocks();
    vi.setSystemTime(NOW + STUCK_AFTER_MS + 1_000);
    expect(await f.t.mutation(internal.delivery.sweepStuck, {})).toBe(1);
    await drivePool(f, id);
    expect(await outboxRow(f, id)).toMatchObject({ state: "sent", attempts: 2 });
  });

  test("a configuration result leaves the row pending with the detail, without a retry", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValue({
      results: [],
      configError: "APNs is not configured: set APNS_KEY",
    });
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("config");
    expect(await outboxRow(f, id)).toMatchObject({
      state: "pending",
      attempts: 1,
      detail: "APNs is not configured: set APNS_KEY",
    });
    expect(providerMocks.apnsSend).toHaveBeenCalledTimes(1);
  });

  test("once configured, the sweeper delivers a row that was held by configuration", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValueOnce({
      results: [],
      configError: "APNs is not configured",
    });
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    await deliver(f, id);
    vi.setSystemTime(NOW + STUCK_AFTER_MS + 1_000);
    expect(await f.t.mutation(internal.delivery.sweepStuck, {})).toBe(1);
    await drivePool(f, id);
    expect(await outboxRow(f, id)).toMatchObject({ state: "sent", attempts: 2 });
  });

  test("a permanent APNs failure that is not configuration stays failed", async () => {
    const f = await setup();
    providerMocks.apnsSend.mockResolvedValue([
      {
        token: "tok-1",
        outcome: "failed",
        status: 400,
        reason: "BadTopic",
        retryable: false,
      },
    ]);
    const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
    expect(await deliver(f, id)).toBe("failed");
    expect(await outboxRow(f, id)).toMatchObject({ state: "failed" });
    expect(await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect())).toHaveLength(
      2,
    );
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

  test("an SMS configuration result leaves the row pending with the detail", async () => {
    const f = await setup();
    providerMocks.smsSend.mockResolvedValue({
      ok: false,
      retryable: false,
      config: true,
      error: "SMS is not configured: set TWILIO_ACCOUNT_SID",
    });
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("config");
    expect(await outboxRow(f, id)).toMatchObject({
      state: "pending",
      detail: "SMS is not configured: set TWILIO_ACCOUNT_SID",
    });
    expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
  });

  test("a configuration problem cannot hold a row past MAX_ATTEMPTS", async () => {
    const f = await setup();
    providerMocks.smsSend.mockResolvedValue({
      ok: false,
      retryable: false,
      config: true,
      error: "SMS is not configured",
    });
    const id = await insertOutbox(f, { recipientUserId: "pat", attempts: MAX_ATTEMPTS - 1 });
    expect(await deliver(f, id)).toBe("config");
    expect(await deliver(f, id)).toBe("failed");
    expect((await outboxRow(f, id)).state).toBe("failed");
  });

  test.each(["digest", "event_notice"] as const)(
    "a timed-out %s text is not retried, since it may have been delivered",
    async (kind) => {
      const f = await setup();
      providerMocks.smsSend.mockResolvedValue({
        ok: false,
        retryable: true,
        timedOut: true,
        error: "Twilio did not answer in time",
      });
      const id = await insertOutbox(f, { kind, recipientUserId: "pat" });
      expect(await deliver(f, id)).toBe("failed");
      const row = await outboxRow(f, id);
      expect(row.state).toBe("failed");
      expect(row.detail).toContain("may have been delivered");
      expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
    },
  );

  test("a timed-out caregiver alert is retried", async () => {
    const f = await setup();
    providerMocks.smsSend.mockResolvedValue({
      ok: false,
      retryable: true,
      timedOut: true,
      error: "Twilio did not answer in time",
    });
    const id = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "pat" });
    await expect(deliver(f, id)).rejects.toThrow(/will retry/);
    expect((await outboxRow(f, id)).state).toBe("pending");
  });

  test("a viewer's caregiver alert has no reply hint, a member's does", async () => {
    const f = await setup();
    await setPhone(f.t, f.householdId, "val", "+15550000003");
    const viewer = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "val" });
    const member = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "max" });
    await deliver(f, viewer);
    await deliver(f, member);
    expect(providerMocks.smsSend.mock.calls[0]![0].body).toBe("Title\nBody");
    expect(providerMocks.smsSend.mock.calls[1]![0].body).toBe(
      "Title\nBody\nReply 1 if you're on it.",
    );
  });
});

async function addTokens(f: DeliveryFixture, userId: string, ...tokens: string[]): Promise<void> {
  await f.t.run(async (ctx) => {
    for (const token of tokens) await ctx.db.insert("pushTokens", { userId, token });
  });
}

function apnsAnswers(outcome: "unregistered" | "failed", status: number, retryable = false): void {
  answerEachToken(() => ({ outcome, status, reason: "Why", retryable }));
}

describe("caregiver push", () => {
  test("a member with a push token gets APNs to every token and no SMS", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1", "pat-2");
    const id = await insertOutbox(f, { kind: "event_notice", recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("sent");
    expect(alertsSent()).toEqual([
      expect.objectContaining({ tokens: ["pat-1", "pat-2"], title: "Title", body: "Body" }),
    ]);
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    expect(await outboxRow(f, id)).toMatchObject({ state: "sent", channel: "apns" });
  });

  test("a member without a token is texted exactly as before", async () => {
    const f = await setup();
    await addTokens(f, "max", "max-1");
    const id = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("sent");
    expect(providerMocks.apnsSend).not.toHaveBeenCalled();
    expect(providerMocks.smsSend).toHaveBeenCalledWith({
      to: "+15550000001",
      body: "Title\nBody\nReply 1 if you're on it.",
    });
    expect(await outboxRow(f, id)).toMatchObject({ state: "sent", channel: "sms" });
  });

  test("a member with a token but no verified phone is pushed", async () => {
    const f = await setup();
    await addTokens(f, "val", "val-1");
    const id = await insertOutbox(f, { kind: "event_notice", recipientUserId: "val" });
    expect(await deliver(f, id)).toBe("sent");
    expect(await outboxRow(f, id)).toMatchObject({ channel: "apns" });
  });

  test("the push carries notification_id, kind, household_id and task_instance_id", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1");
    const taskInstanceId = await addInstance(f.t, f.householdId, "Pills", { state: "escalated" });
    const id = await insertOutbox(f, {
      kind: "caregiver_alert",
      recipientUserId: "pat",
      taskInstanceId,
    });
    await deliver(f, id);
    expect(alertsSent()[0]!.data).toEqual({
      notification_id: id,
      kind: "caregiver_alert",
      household_id: f.householdId,
      task_instance_id: taskInstanceId,
    });
  });

  test("a claimable alert is time-sensitive with the caregiver_alert category", async () => {
    const f = await setup();
    await addTokens(f, "max", "max-1");
    const id = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "max" });
    await deliver(f, id);
    expect(alertsSent()[0]!).toMatchObject({
      interruptionLevel: "time-sensitive",
      category: "caregiver_alert",
    });
  });

  test("a viewer's alert is time-sensitive with no category", async () => {
    const f = await setup();
    await addTokens(f, "val", "val-1");
    const id = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "val" });
    await deliver(f, id);
    const sent = alertsSent()[0]!;
    expect(sent.interruptionLevel).toBe("time-sensitive");
    expect(sent).not.toHaveProperty("category");
  });

  test("an agent flag is time-sensitive; a digest, notice and message are not", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1");
    const kinds = ["agent_flag", "digest", "event_notice", "family_message"] as const;
    for (const kind of kinds) {
      await deliver(f, await insertOutbox(f, { kind, recipientUserId: "pat" }));
    }
    const levels = alertsSent().map((alert) => alert.interruptionLevel);
    expect(levels).toEqual(["time-sensitive", undefined, undefined, undefined]);
    for (const alert of alertsSent()) expect(alert).not.toHaveProperty("category");
  });

  test("a senior prompt to a device is time-sensitive with no category", async () => {
    const f = await setup();
    await deliver(
      f,
      await insertOutbox(f, { kind: "senior_prompt", recipientDeviceId: f.deviceId }),
    );
    await deliver(
      f,
      await insertOutbox(f, { kind: "event_notice", recipientDeviceId: f.deviceId }),
    );
    const [prompt, notice] = alertsSent();
    expect(prompt).toMatchObject({ interruptionLevel: "time-sensitive" });
    expect(prompt).not.toHaveProperty("category");
    expect(notice).not.toHaveProperty("interruptionLevel");
  });

  test("a push uses payload.pushTitle while the SMS keeps the title", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1");
    const fields = {
      kind: "digest" as const,
      title: "Sunny: Mom's day",
      body: "All done.",
      payload: { pushTitle: "Mom's day" },
    };
    await deliver(f, await insertOutbox(f, { ...fields, recipientUserId: "pat" }));
    await deliver(f, await insertOutbox(f, { ...fields, recipientUserId: "max" }));
    expect(alertsSent()[0]!).toMatchObject({
      title: "Mom's day",
      body: "All done.",
    });
    expect(providerMocks.smsSend).toHaveBeenCalledWith({
      to: "+15550000002",
      body: "Sunny: Mom's day\nAll done.",
    });
  });

  test("every token unregistered: the same row is texted and the tokens are gone", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1", "pat-2");
    apnsAnswers("unregistered", 410);
    const id = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("sent");
    expect(providerMocks.smsSend).toHaveBeenCalledWith({
      to: "+15550000001",
      body: "Title\nBody\nReply 1 if you're on it.",
    });
    expect(await outboxRow(f, id)).toMatchObject({ state: "sent", channel: "sms", attempts: 1 });
    const left = await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(left.map((t) => t.userId)).toEqual(["phone", "phone"]);
  });

  test("every token refused for good also falls back to the text", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1");
    apnsAnswers("failed", 400);
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("sent");
    expect(await outboxRow(f, id)).toMatchObject({ channel: "sms" });
  });

  test("one token unregistered and one refused for good: the dead one goes, the row is texted", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-dead", "pat-bad");
    providerMocks.apnsSend.mockResolvedValue([
      { token: "pat-dead", outcome: "unregistered", status: 410, reason: "Gone", retryable: false },
      {
        token: "pat-bad",
        outcome: "failed",
        status: 400,
        reason: "BadTopic",
        retryable: false,
      },
    ]);
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("sent");
    expect(await outboxRow(f, id)).toMatchObject({ state: "sent", channel: "sms" });
    const left = await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(left.map((t) => t.token)).toContain("pat-bad");
    expect(left.map((t) => t.token)).not.toContain("pat-dead");
  });

  test("a failed fallback text settles the row as the SMS path does", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1");
    apnsAnswers("unregistered", 410);
    providerMocks.smsSend.mockResolvedValue({ ok: false, retryable: false, error: "21211 bad" });
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("failed");
    expect(await outboxRow(f, id)).toMatchObject({ state: "failed", detail: "21211 bad" });
  });

  test("dead tokens and no verified phone: skipped, nothing texted", async () => {
    const f = await setup();
    await addTokens(f, "val", "val-1");
    apnsAnswers("unregistered", 410);
    const id = await insertOutbox(f, { recipientUserId: "val" });
    expect(await deliver(f, id)).toBe("skipped");
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    expect(await outboxRow(f, id)).toMatchObject({
      state: "skipped",
      detail: "tokens_unregistered",
    });
  });

  test("a retryable push failure is retried, not texted", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1");
    apnsAnswers("failed", 503, true);
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    await expect(deliver(f, id)).rejects.toThrow(/will retry/);
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    expect(await outboxRow(f, id)).toMatchObject({ state: "pending", pushState: "retrying" });
  });

  test("one token unregistered and one retryable: the dead one goes, the row is retried", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-dead", "pat-busy");
    providerMocks.apnsSend.mockResolvedValue([
      { token: "pat-dead", outcome: "unregistered", status: 410, reason: "Gone", retryable: false },
      { token: "pat-busy", outcome: "failed", status: 503, reason: "Busy", retryable: true },
    ]);
    const id = await insertOutbox(f, { recipientUserId: "pat" });
    await expect(deliver(f, id)).rejects.toThrow(/will retry/);
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    expect((await outboxRow(f, id)).state).toBe("pending");
    const left = await f.t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(left.map((t) => t.token)).toContain("pat-busy");
    expect(left.map((t) => t.token)).not.toContain("pat-dead");
  });

  test("APNs not configured: a caregiver with a verified phone is texted", async () => {
    const f = await setup();
    await addTokens(f, "pat", "pat-1");
    providerMocks.apnsSend.mockResolvedValue({
      results: [],
      configError: "APNs is not configured",
    });
    const id = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "pat" });
    expect(await deliver(f, id)).toBe("sent");
    expect(providerMocks.smsSend).toHaveBeenCalledWith({
      to: "+15550000001",
      body: "Title\nBody\nReply 1 if you're on it.",
    });
    expect(await outboxRow(f, id)).toMatchObject({ state: "sent", channel: "sms" });
  });

  test("APNs not configured and no verified phone: the row waits for the configuration", async () => {
    const f = await setup();
    await addTokens(f, "val", "val-1");
    providerMocks.apnsSend.mockResolvedValue({
      results: [],
      configError: "APNs is not configured",
    });
    const id = await insertOutbox(f, { recipientUserId: "val" });
    expect(await deliver(f, id)).toBe("config");
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    expect(await outboxRow(f, id)).toMatchObject({
      state: "pending",
      detail: "APNs is not configured",
    });
  });

  describe("push retries running out", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    async function retriesRanOut(f: DeliveryFixture, id: Id<"notificationOutbox">): Promise<void> {
      await f.t.mutation(internal.delivery.onDeliveryComplete, {
        workId: "work_1" as WorkId,
        context: { outboxId: id },
        result: { kind: "failed", error: "APNs delivery failed, will retry: 503 Busy" },
      });
    }

    test("with a verified phone the row is texted exactly once", async () => {
      const f = await setup();
      await addTokens(f, "pat", "pat-1");
      apnsAnswers("failed", 503, true);
      const id = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "pat" });
      await expect(deliver(f, id)).rejects.toThrow(/will retry/);
      await expect(deliver(f, id)).rejects.toThrow(/will retry/);
      await retriesRanOut(f, id);
      expect(await outboxRow(f, id)).toMatchObject({ state: "pending", pushState: "gave_up" });
      const pushes = providerMocks.apnsSend.mock.calls.length;
      expect(await deliver(f, id)).toBe("sent");
      expect(providerMocks.apnsSend).toHaveBeenCalledTimes(pushes);
      expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
      expect(await outboxRow(f, id)).toMatchObject({ state: "sent", channel: "sms" });
      await retriesRanOut(f, id);
      vi.setSystemTime(NOW + STUCK_AFTER_MS + 60_000);
      expect(await f.t.mutation(internal.delivery.sweepStuck, {})).toBe(0);
      expect(await deliver(f, id)).toBe("settled");
      expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
    });

    test("a text that also runs out of retries ends failed, not enqueued again", async () => {
      const f = await setup();
      await addTokens(f, "pat", "pat-1");
      apnsAnswers("failed", 503, true);
      providerMocks.smsSend.mockResolvedValue({ ok: false, retryable: true, error: "503 busy" });
      const id = await insertOutbox(f, { recipientUserId: "pat" });
      await expect(deliver(f, id)).rejects.toThrow(/will retry/);
      await retriesRanOut(f, id);
      await expect(deliver(f, id)).rejects.toThrow(/SMS delivery failed/);
      await retriesRanOut(f, id);
      expect(await outboxRow(f, id)).toMatchObject({ state: "failed", pushState: "gave_up" });
      expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
    });

    test("without a verified phone the row ends failed", async () => {
      const f = await setup();
      await addTokens(f, "val", "val-1");
      apnsAnswers("failed", 503, true);
      const id = await insertOutbox(f, { recipientUserId: "val" });
      await expect(deliver(f, id)).rejects.toThrow(/will retry/);
      await retriesRanOut(f, id);
      expect((await outboxRow(f, id)).state).toBe("failed");
      expect(providerMocks.smsSend).not.toHaveBeenCalled();
    });

    test("a device row ends failed as before", async () => {
      const f = await setup();
      apnsAnswers("failed", 503, true);
      const id = await insertOutbox(f, { recipientDeviceId: f.deviceId });
      await expect(deliver(f, id)).rejects.toThrow(/will retry/);
      expect((await outboxRow(f, id)).pushState).toBeUndefined();
      await retriesRanOut(f, id);
      expect((await outboxRow(f, id)).state).toBe("failed");
    });

    test("a fallback text that fails after an earlier push retry clears the mark and ends failed", async () => {
      const f = await setup();
      await addTokens(f, "pat", "pat-1");
      const id = await insertOutbox(f, { recipientUserId: "pat" });
      apnsAnswers("failed", 503, true);
      await expect(deliver(f, id)).rejects.toThrow(/APNs delivery failed/);
      expect((await outboxRow(f, id)).pushState).toBe("retrying");
      apnsAnswers("unregistered", 410);
      providerMocks.smsSend.mockResolvedValue({ ok: false, retryable: true, error: "503 busy" });
      await expect(deliver(f, id)).rejects.toThrow(/SMS delivery failed/);
      expect((await outboxRow(f, id)).pushState).toBeUndefined();
      await retriesRanOut(f, id);
      const row = await outboxRow(f, id);
      expect(row.state).toBe("failed");
      expect(row.pushState).toBeUndefined();
      expect(await deliver(f, id)).toBe("settled");
      expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
    });

    test("an SMS-only caregiver whose text runs out of retries ends failed", async () => {
      const f = await setup();
      providerMocks.smsSend.mockResolvedValue({ ok: false, retryable: true, error: "503 busy" });
      const id = await insertOutbox(f, { recipientUserId: "pat" });
      await expect(deliver(f, id)).rejects.toThrow(/SMS delivery failed/);
      await retriesRanOut(f, id);
      expect((await outboxRow(f, id)).state).toBe("failed");
      expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
    });
  });

  test("a member who left is skipped even with a token", async () => {
    const f = await setup();
    await addTokens(f, "max", "max-1");
    await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.removeMember, { householdId: f.householdId, userId: "max" });
    const id = await insertOutbox(f, { kind: "caregiver_alert", recipientUserId: "max" });
    expect(await deliver(f, id)).toBe("skipped");
    expect(providerMocks.apnsSend).not.toHaveBeenCalled();
    expect(providerMocks.smsSend).not.toHaveBeenCalled();
    expect((await outboxRow(f, id)).detail).toBe("recipient_left");
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

  test("a row a delivery run started within the last 5 minutes is leased and skipped", async () => {
    const f = await setup();
    await insertOutbox(f, {
      recipientUserId: "pat",
      attemptStartedAt: NOW + STUCK_AFTER_MS - 60_000,
    });
    const idle = await insertOutbox(f, { recipientUserId: "max", attemptStartedAt: NOW });
    vi.setSystemTime(NOW + STUCK_AFTER_MS + 1_000);
    expect(await f.t.mutation(internal.delivery.sweepStuck, {})).toBe(1);
    expect(idle).toBeDefined();
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

  test("a caregiver's push that keeps failing is texted once when the retries run out", async () => {
    const f = await setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await addTokens(f, "pat", "pat-1");
    apnsAnswers("failed", 503, true);
    const id = await f.t.run(
      async (ctx) =>
        await insertNotification(ctx, {
          householdId: f.householdId,
          kind: "caregiver_alert",
          recipientUserId: "pat",
          title: "t",
          body: "b",
          payload: {},
        }),
    );
    await drivePool(f, id);
    expect(providerMocks.apnsSend.mock.calls.length).toBeGreaterThan(1);
    expect(providerMocks.smsSend).toHaveBeenCalledTimes(1);
    expect(providerMocks.smsSend.mock.calls[0]![0].body).toBe("t\nb\nReply 1 if you're on it.");
    expect(await outboxRow(f, id)).toMatchObject({
      state: "sent",
      channel: "sms",
      pushState: "gave_up",
    });
    errorSpy.mockRestore();
  });
});
