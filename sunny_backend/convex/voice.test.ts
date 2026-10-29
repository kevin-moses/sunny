// convex/voice.test.ts
// Purpose: Tests for voice.livekitToken: only a paired device may call it (signed out,
// caregivers and removed devices are refused), the task instance must belong to the device's
// household, the minted token decodes to the exact snake_case participant metadata the Python
// agent parses, the room and identity naming, the one-hour ttl and grants, the default and
// accepted triggers, and an error when the LiveKit env vars are missing. LiveKit is never
// contacted: the token is signed locally and decoded here.
//
// Last modified: 2026-10-29

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const ENV_KEYS = ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_SERVER_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.LIVEKIT_API_KEY = "devkey";
  process.env.LIVEKIT_API_SECRET = "a-long-enough-test-secret-for-hs256-signing";
  process.env.LIVEKIT_SERVER_URL = "wss://livekit.test";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/**
 * purpose: A fresh in-memory backend.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  return convexTest(schema, modules);
}

/** The convex-test harness type. */
type TestConvex = ReturnType<typeof makeBackend>;

/** A household with one paired device ("phone") and an instance in it. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  deviceId: Id<"devices">;
  instanceId: Id<"taskInstances">;
}

/**
 * purpose: Insert a household with a task instance directly.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<{householdId, instanceId}>) The ids.
 */
async function seedHousehold(
  t: TestConvex,
): Promise<{ householdId: Id<"households">; instanceId: Id<"taskInstances"> }> {
  return await t.run(async (ctx) => {
    const householdId = await ctx.db.insert("households", {
      seniorPreferredName: "Margaret",
      timezone: "America/New_York",
      digestTime: "19:00",
      eventNoticeTime: "08:00",
      shareTranscripts: false,
      backgroundPaused: false,
    });
    const taskId = await ctx.db.insert("tasks", {
      householdId,
      type: "medication",
      title: "Pills",
      displayLabel: "Pills",
      spokenPrompt: "Time for pills.",
      checklistItems: [],
      times: ["08:00"],
      windowMinutes: 60,
      createdByKind: "caregiver",
      active: true,
      scheduleChangedAt: 0,
    });
    const instanceId = await ctx.db.insert("taskInstances", {
      taskId,
      householdId,
      localDate: "2027-03-14",
      scheduledTime: "08:00",
      windowStart: 0,
      windowEnd: 1,
      state: "due",
      createdAt: 0,
      firedSteps: [],
    });
    return { householdId, instanceId };
  });
}

/**
 * purpose: Build a household with a paired device user "phone" and an instance.
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(): Promise<Fixture> {
  const t = makeBackend();
  const { householdId, instanceId } = await seedHousehold(t);
  const deviceId = await t.run(
    async (ctx) =>
      await ctx.db.insert("devices", { householdId, userId: "phone", kind: "senior_phone" }),
  );
  return { t, householdId, deviceId, instanceId };
}

/**
 * purpose: Decode the payload of a JWT without verifying it.
 * @param jwt: (string) The token.
 * @return: (Record<string, unknown>) The claims.
 */
function claims(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload)) as Record<string, unknown>;
}

describe("livekitToken", () => {
  test("returns the connection details with the exact metadata keys", async () => {
    const f = await setup();
    const result = await f.t.withIdentity({ subject: "phone" }).action(api.voice.livekitToken, {});

    expect(result.serverUrl).toBe("wss://livekit.test");
    expect(result.participantName).toBe(`device-${f.deviceId}`);
    expect(result.roomName).toMatch(new RegExp(`^household-${f.householdId}-[0-9a-f]{8}$`));
    const token = claims(result.participantToken);
    expect(token.sub).toBe(`device-${f.deviceId}`);
    expect(token.iss).toBe("devkey");
    expect(JSON.parse(token.metadata as string)).toEqual({
      household_id: f.householdId,
      device_id: f.deviceId,
      trigger: "talk",
    });
    expect(Object.keys(JSON.parse(token.metadata as string))).toEqual([
      "household_id",
      "device_id",
      "trigger",
    ]);
  });

  test("grants the room with publish, subscribe and data, for one hour", async () => {
    const f = await setup();
    const result = await f.t.withIdentity({ subject: "phone" }).action(api.voice.livekitToken, {});
    const token = claims(result.participantToken);
    expect(token.video).toMatchObject({
      room: result.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    expect((token.exp as number) - (token.nbf as number)).toBe(3600);
  });

  test("includes the trigger and task_instance_id when given", async () => {
    const f = await setup();
    const result = await f.t.withIdentity({ subject: "phone" }).action(api.voice.livekitToken, {
      trigger: "scheduled_prompt",
      taskInstanceId: f.instanceId,
    });
    expect(JSON.parse(claims(result.participantToken).metadata as string)).toEqual({
      household_id: f.householdId,
      device_id: f.deviceId,
      trigger: "scheduled_prompt",
      task_instance_id: f.instanceId,
    });
  });

  test("each call gets a different room", async () => {
    const f = await setup();
    const asPhone = f.t.withIdentity({ subject: "phone" });
    const a = await asPhone.action(api.voice.livekitToken, { trigger: "notification_tap" });
    const b = await asPhone.action(api.voice.livekitToken, { trigger: "notification_tap" });
    expect(a.roomName).not.toBe(b.roomName);
  });

  test("an unknown trigger is rejected by validation", async () => {
    const f = await setup();
    await expect(
      f.t
        .withIdentity({ subject: "phone" })
        // @ts-expect-error not a valid trigger
        .action(api.voice.livekitToken, { trigger: "shout" }),
    ).rejects.toThrow();
  });
});

describe("livekitToken access", () => {
  test("signed out is unauthenticated", async () => {
    const f = await setup();
    await expect(f.t.action(api.voice.livekitToken, {})).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });

  test("a caregiver is not a paired device", async () => {
    const f = await setup();
    const asA = f.t.withIdentity({ subject: "user_a" });
    await asA.mutation(api.households.create, {
      seniorPreferredName: "X",
      timezone: "America/New_York",
      caregiverDisplayName: "A",
    });
    await expect(asA.action(api.voice.livekitToken, {})).rejects.toMatchObject({
      data: { code: "forbidden", message: "This device is not paired with a household" },
    });
  });

  test("a removed device is refused", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.delete(f.deviceId));
    await expect(
      f.t.withIdentity({ subject: "phone" }).action(api.voice.livekitToken, {}),
    ).rejects.toMatchObject({
      data: { code: "forbidden", message: "This device is not paired with a household" },
    });
  });

  test("a task instance of another household is rejected", async () => {
    const f = await setup();
    const other = await seedHousehold(f.t);
    await expect(
      f.t
        .withIdentity({ subject: "phone" })
        .action(api.voice.livekitToken, { taskInstanceId: other.instanceId }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("a deleted task instance is rejected", async () => {
    const f = await setup();
    await f.t.run(async (ctx) => await ctx.db.delete(f.instanceId));
    await expect(
      f.t
        .withIdentity({ subject: "phone" })
        .action(api.voice.livekitToken, { taskInstanceId: f.instanceId }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  test("resolveDevice maps the user to its household and device", async () => {
    const f = await setup();
    const resolved = await f.t.query(internal.voice.resolveDevice, { userId: "phone" });
    expect(resolved).toEqual({ householdId: f.householdId, deviceId: f.deviceId });
  });
});

describe("livekitToken configuration", () => {
  test.each(ENV_KEYS)("a missing %s is an error", async (key) => {
    const f = await setup();
    delete process.env[key];
    await expect(
      f.t.withIdentity({ subject: "phone" }).action(api.voice.livekitToken, {}),
    ).rejects.toThrow(/LiveKit is not configured/);
  });
});
