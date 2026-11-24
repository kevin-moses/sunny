import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { frameDoneTarget } from "./lib/deviceState";
import type { DeviceState } from "./lib/deviceState";
import { hashDeviceToken } from "./lib/deviceToken";
import type { PhoneTimeline } from "./lib/phoneTimeline";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const MIN = 60_000;
const START = "2026-11-13T12:00:00Z";

function local(hhmm: string, date = "2026-11-13"): number {
  return Date.parse(`${date}T${hhmm}:00-05:00`);
}

function setNow(ms: number): void {
  vi.setSystemTime(new Date(ms));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(START));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeBackend() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  workpoolTest.register(t, "deliveryPool");
  return t;
}

type TestConvex = ReturnType<typeof makeBackend>;

interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  instanceId: Id<"taskInstances">;
  phoneId: Id<"devices">;
}

async function household(t: TestConvex, prefix = ""): Promise<Fixture> {
  const pat = t.withIdentity({ subject: `${prefix}pat` });
  const householdId = await pat.mutation(api.households.create, {
    seniorPreferredName: "Mom",
    timezone: "America/New_York",
    caregiverDisplayName: "Pat",
  });
  for (const [grants, userId] of [
    ["senior_phone", `${prefix}phone`],
    ["home_display", `${prefix}display`],
  ] as const) {
    const { code } = await pat.mutation(api.households.createJoinCode, { householdId, grants });
    await t.mutation(internal.households.pairDevice, { code, userId });
  }
  await pat.mutation(api.tasks.create, {
    householdId,
    type: "medication",
    title: "Morning pills",
    displayLabel: "Morning pills",
    times: ["08:00"],
  });
  const { instanceId, phoneId } = await t.run(async (ctx) => {
    const instance = await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) =>
        q.eq("householdId", householdId).eq("localDate", "2026-11-13"),
      )
      .first();
    const phone = await ctx.db
      .query("devices")
      .withIndex("by_user", (q) => q.eq("userId", `${prefix}phone`))
      .unique();
    return { instanceId: instance!._id, phoneId: phone!._id };
  });
  return { t, householdId, instanceId, phoneId };
}

async function issue(t: TestConvex, subject = "phone"): Promise<string> {
  const { deviceToken } = await t.withIdentity({ subject }).action(api.deviceApi.issueToken, {});
  return deviceToken;
}

async function call(
  t: TestConvex,
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token != null) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return await t.fetch(path, {
    method,
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
  });
}

async function getState(
  t: TestConvex,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await call(t, "GET", "/device/state", { token, headers });
}

async function getTimeline(
  t: TestConvex,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await call(t, "GET", "/device/timeline", { token, headers });
}

async function postConfirm(t: TestConvex, token: string, body: unknown): Promise<Response> {
  return await call(t, "POST", "/device/confirm", { token, body });
}

async function postUndo(t: TestConvex, token: string, body: unknown): Promise<Response> {
  return await call(t, "POST", "/device/undo", { token, body });
}

async function putInfo(t: TestConvex, token: string, body: unknown): Promise<Response> {
  return await call(t, "PUT", "/device/info", { token, body });
}

async function deviceRow(t: TestConvex, deviceId: Id<"devices">) {
  return await t.run(async (ctx) => await ctx.db.get(deviceId));
}

async function audits(t: TestConvex) {
  return await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
}

async function force(f: Fixture, patch: Record<string, unknown>): Promise<void> {
  await f.t.run(async (ctx) => await ctx.db.patch(f.instanceId, patch));
}

async function verdict(res: Response): Promise<{ status: unknown; reason: unknown }> {
  const { status, reason } = (await res.json()) as Record<string, unknown>;
  return { status, reason };
}

function near(actual: number | undefined, expected: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) < 100;
}

const UNKNOWN_TOKEN = `sunny_dev_${"Q".repeat(43)}`;

const PRESS_A = "6F1B2C3D-0000-4000-8000-00000000000A";
const PRESS_B = "6F1B2C3D-0000-4000-8000-00000000000B";

describe("issueToken", () => {
  test("returns a token once and stores only its hash, audited without either", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    expect(token).toMatch(/^sunny_dev_[A-Za-z0-9_-]{43}$/);
    const row = await deviceRow(t, f.phoneId);
    expect(row!.tokenHash).toBe(await hashDeviceToken(token));
    expect(near(row!.tokenIssuedAt, Date.parse(START))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(token);
    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "issue_device_token"),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: "senior_device",
      actorUserId: "phone",
      entity: "device",
      entityId: f.phoneId,
      detail: { replaced: false },
    });
    expect(JSON.stringify(audits[0])).not.toContain(token);
    expect(JSON.stringify(audits[0])).not.toContain(row!.tokenHash!);
    expect((await getState(t, token)).status).toBe(200);
  });

  test("a new token replaces the old one, which then gets 401", async () => {
    const t = makeBackend();
    await household(t);
    const first = await issue(t);
    const second = await issue(t);
    expect(second).not.toBe(first);
    expect((await getState(t, first)).status).toBe(401);
    expect((await getState(t, second)).status).toBe(200);
    const audits = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(audits.filter((a) => a.action === "issue_device_token").map((a) => a.detail)).toEqual([
      { replaced: false },
      { replaced: true },
    ]);
  });

  test("a device may issue 10 tokens an hour, then is refused until the bucket refills", async () => {
    const t = makeBackend();
    await household(t);
    let last = "";
    for (let i = 0; i < 10; i++) last = await issue(t);
    await expect(issue(t)).rejects.toThrow(/Too many new device tokens/);
    expect((await getState(t, last)).status).toBe(200);
    setNow(Date.parse(START) + 7 * MIN);
    expect(await issue(t)).toMatch(/^sunny_dev_/);
  });

  test("each device has its own token", async () => {
    const t = makeBackend();
    await household(t);
    const phone = await issue(t, "phone");
    const display = await issue(t, "display");
    expect((await getState(t, phone)).status).toBe(200);
    expect((await getState(t, display)).status).toBe(200);
  });

  test("a caregiver or a signed-out caller cannot issue, and nothing is stored", async () => {
    const t = makeBackend();
    const f = await household(t);
    await expect(
      t.withIdentity({ subject: "pat" }).action(api.deviceApi.issueToken, {}),
    ).rejects.toThrow(/Only the senior's devices/);
    await expect(t.action(api.deviceApi.issueToken, {})).rejects.toThrow(/Sign in first/);
    const rows = await t.run(async (ctx) => await ctx.db.query("devices").collect());
    expect(rows.every((r) => r.tokenHash === undefined)).toBe(true);
    expect((await deviceRow(t, f.phoneId))!.tokenIssuedAt).toBeUndefined();
  });

  test("removing the device revokes its token at once", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    expect((await getState(t, token)).status).toBe(200);
    await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.removeDevice, { householdId: f.householdId, deviceId: f.phoneId });
    expect((await getState(t, token)).status).toBe(401);
    expect(
      (await postConfirm(t, token, { instanceId: f.instanceId, pressedAgoMs: 0, via: "widget" }))
        .status,
    ).toBe(401);
  });

  test("the hash never appears in listDevices or any response, the token in no log", async () => {
    const t = makeBackend();
    const f = await household(t);
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const token = await issue(t);
    const hash = (await deviceRow(t, f.phoneId))!.tokenHash!;
    const asPat = t.withIdentity({ subject: "pat" });
    const asPhone = t.withIdentity({ subject: "phone" });
    const listed = await asPat.query(api.households.listDevices, { householdId: f.householdId });
    const phone = listed.find((d) => d._id === f.phoneId)!;
    expect(phone).not.toHaveProperty("tokenHash");
    expect(near(phone.tokenIssuedAt, Date.parse(START))).toBe(true);
    const views: unknown[] = [
      listed,
      await asPhone.query(api.households.listDevices, { householdId: f.householdId }),
      await asPhone.query(api.households.mine, {}),
      await asPhone.query(api.deviceApi.state, {}),
    ];
    const bodies = [
      await (await getState(t, token)).text(),
      await (
        await postConfirm(t, token, { instanceId: f.instanceId, pressedAgoMs: 0, via: "widget" })
      ).text(),
    ];
    for (const text of [...views.map((v) => JSON.stringify(v)), ...bodies]) {
      expect(text).not.toContain(hash);
      expect(text).not.toContain(token);
    }
    const theirs = await household(t, "z_");
    await postConfirm(t, token, { instanceId: theirs.instanceId, pressedAgoMs: 0, via: "widget" });
    await postConfirm(t, token, { instanceId: "abc", pressedAgoMs: 0, via: "widget" });
    const audits = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    for (const text of [...logged, ...audits.map((a) => JSON.stringify(a))]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(hash);
    }
  });
});

describe("authentication", () => {
  test("missing, malformed and unknown tokens get one identical 401", async () => {
    const t = makeBackend();
    await household(t);
    const responses = [
      await getState(t, null),
      await getState(t, null, { Authorization: "Basic abc" }),
      await getState(t, null, { Authorization: "Bearer not-a-token" }),
      await getState(t, null, { Authorization: `Bearer sunny_dev_${"Q".repeat(42)}` }),
      await getState(t, UNKNOWN_TOKEN),
    ];
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const r of responses) {
      expect(r.status).toBe(401);
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect(r.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({
      error: { code: "unauthenticated", message: "A valid device token is required" },
    });
  });

  test("the token is checked before the body, on every route", async () => {
    const t = makeBackend();
    await household(t);
    expect((await call(t, "POST", "/device/confirm", { body: "{nope" })).status).toBe(401);
    expect((await call(t, "POST", "/device/undo", { body: "{nope" })).status).toBe(401);
    expect(
      (await call(t, "PUT", "/device/info", { token: UNKNOWN_TOKEN, body: "[]" })).status,
    ).toBe(401);
  });

  test("60 failed attempts a minute exhaust the global bucket, a valid token still works", async () => {
    const t = makeBackend();
    await household(t);
    const token = await issue(t);
    for (let i = 0; i < 60; i++) expect((await getState(t, UNKNOWN_TOKEN)).status).toBe(401);
    const limited = await getState(t, UNKNOWN_TOKEN);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect((await getState(t, null)).status).toBe(429);
    expect((await getState(t, token)).status).toBe(200);
    setNow(Date.parse(START) + MIN);
    expect((await getState(t, UNKNOWN_TOKEN)).status).toBe(401);
  });

  test("while the global bucket is empty the per-IP bucket is not spent", async () => {
    const t = makeBackend();
    await household(t);
    const ipA = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 60; i++) await getState(t, UNKNOWN_TOKEN);
    for (let i = 0; i < 10; i++) {
      expect((await getState(t, UNKNOWN_TOKEN, ipA)).status).toBe(429);
    }
    setNow(Date.parse(START) + 30_000);
    for (let i = 0; i < 10; i++) {
      expect((await getState(t, UNKNOWN_TOKEN, ipA)).status).toBe(401);
    }
  });

  test("10 failed attempts a minute from one IP limit that IP only", async () => {
    const t = makeBackend();
    await household(t);
    const ipA = { "x-forwarded-for": "203.0.113.7" };
    const ipB = { "x-forwarded-for": "198.51.100.2" };
    for (let i = 0; i < 10; i++) {
      expect((await getState(t, UNKNOWN_TOKEN, ipA)).status).toBe(401);
    }
    expect((await getState(t, UNKNOWN_TOKEN, ipA)).status).toBe(429);
    expect((await getState(t, UNKNOWN_TOKEN, ipB)).status).toBe(401);
  });

  test("a device gets 120 requests a minute, then 429; another device is unaffected", async () => {
    const t = makeBackend();
    await household(t);
    const phone = await issue(t, "phone");
    const display = await issue(t, "display");
    for (let i = 0; i < 120; i++) expect((await getState(t, phone)).status).toBe(200);
    const limited = await getState(t, phone);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect((await getState(t, display)).status).toBe(200);
  });
});

describe("GET /device/state", () => {
  test("carries the version as ETag and answers a matching If-None-Match with 304", async () => {
    const t = makeBackend();
    await household(t);
    const token = await issue(t);
    const res = await getState(t, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const state = (await res.json()) as { version: string };
    const etag = `"${state.version}"`;
    expect(res.headers.get("ETag")).toBe(etag);
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const cached = await getState(t, token, { "If-None-Match": header });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
      expect(cached.headers.get("ETag")).toBe(etag);
      expect(cached.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await getState(t, token, { "If-None-Match": '"stale"' })).status).toBe(200);
  });

  test("a change to the day changes the ETag", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    const before = (await getState(t, token)).headers.get("ETag")!;
    await force(f, { state: "due" });
    const after = await getState(t, token, { "If-None-Match": before });
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(before);
  });

  test("the Clerk query and the HTTP route return the identical object", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t, "display");
    const viaHttp = await (await getState(t, token)).json();
    const viaQuery = await t
      .withIdentity({ subject: "display" })
      .query(api.deviceApi.state, { minute: 1 });
    expect(viaHttp).toEqual(viaQuery);
    expect(viaQuery.done).toEqual({ instanceId: f.instanceId, early: false, step: 0 });
  });

  test("the query refuses caregivers and signed-out callers", async () => {
    const t = makeBackend();
    await household(t);
    await expect(t.withIdentity({ subject: "pat" }).query(api.deviceApi.state, {})).rejects.toThrow(
      /Only the senior's devices/,
    );
    await expect(t.query(api.deviceApi.state, {})).rejects.toThrow(/Sign in first/);
  });

  test("predicts the senior prompts exactly when the scheduler sends them", async () => {
    const t = makeBackend();
    const f = await household(t);
    const asPhone = t.withIdentity({ subject: "phone" });
    const before = await asPhone.query(api.deviceApi.state, {});
    const cue = before.cues.find((c) => c.instanceId === f.instanceId)!;
    expect(cue.cueableNow).toBe(false);
    expect(cue.promptTimes).toEqual([local("08:00"), local("08:15")]);
    const tickAt = async (now: number): Promise<number> => {
      setNow(now);
      await t.mutation(internal.scheduler.tickHousehold, { householdId: f.householdId, now });
      const state = await asPhone.query(api.deviceApi.state, {});
      return state.cues.find((c) => c.instanceId === f.instanceId)?.seniorPrompts ?? -1;
    };
    expect(await tickAt(cue.promptTimes[0]! - MIN)).toBe(0);
    expect(await tickAt(cue.promptTimes[0]!)).toBe(1);
    expect(await tickAt(cue.promptTimes[1]! - MIN)).toBe(1);
    expect(await tickAt(cue.promptTimes[1]!)).toBe(2);
    const after = await asPhone.query(api.deviceApi.state, {});
    expect(after.cues.find((c) => c.instanceId === f.instanceId)).toMatchObject({
      cueableNow: true,
      promptTimes: [],
    });
  });

  test("lists tomorrow's instance when its prompts fall inside the 24 hours", async () => {
    const t = makeBackend();
    await household(t);
    setNow(local("20:00"));
    const state = await t.withIdentity({ subject: "phone" }).query(api.deviceApi.state, {});
    const tomorrow = state.cues.filter((c) => c.localDate === "2026-11-14");
    expect(tomorrow).toHaveLength(1);
    expect(tomorrow[0]!.promptTimes).toEqual([
      local("08:00", "2026-11-14"),
      local("08:15", "2026-11-14"),
    ]);
    expect(tomorrow[0]!.speech).toBe(
      "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.",
    );
  });
});

async function addPhoneDay(f: Fixture): Promise<void> {
  const pat = f.t.withIdentity({ subject: "pat" });
  await pat.mutation(api.tasks.create, {
    householdId: f.householdId,
    type: "routine",
    title: "Get ready",
    displayLabel: "Get ready",
    times: ["08:00"],
    windowMinutes: 120,
    checklistItems: ["Shower", "Dress"],
  });
  await pat.mutation(api.tasks.create, {
    householdId: f.householdId,
    type: "medication",
    title: "Lunch pills",
    displayLabel: "Lunch pills",
    times: ["12:00"],
  });
  await f.t.run(async (ctx) => {
    const instance = await ctx.db.get(f.instanceId);
    await ctx.db.patch(instance!.taskId, {
      screenSentence: "Take your morning pills.",
      pillDescription: "1 white tablet",
    });
  });
}

async function readTimeline(t: TestConvex, token: string): Promise<PhoneTimeline> {
  const res = await getTimeline(t, token);
  expect(res.status).toBe(200);
  return (await res.json()) as PhoneTimeline;
}

async function readState(t: TestConvex, token: string): Promise<DeviceState> {
  return (await (await getState(t, token)).json()) as DeviceState;
}

async function instanceIdOf(f: Fixture, label: string, date = "2026-11-13") {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) =>
        q.eq("householdId", f.householdId).eq("localDate", date),
      )
      .collect();
    for (const row of rows) {
      if ((await ctx.db.get(row.taskId))!.displayLabel === label) return row._id;
    }
    throw new Error(`no instance of ${label}`);
  });
}

function firstCardAgrees(state: DeviceState, cards: PhoneTimeline["entries"][number]["cards"]) {
  const target = frameDoneTarget(state);
  const first = cards[0]!;
  if (target === null) return first.kind === "clear";
  return (
    first.kind === "task" && first.instanceId === target.instanceId && first.step === target.step
  );
}

describe("GET /device/timeline", () => {
  test("refuses a missing or unknown token with the device API's 401", async () => {
    const t = makeBackend();
    await household(t);
    for (const res of [await getTimeline(t, null), await getTimeline(t, UNKNOWN_TOKEN)]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual({
        error: { code: "unauthenticated", message: "A valid device token is required" },
      });
    }
  });

  test("carries the version as ETag and answers a matching If-None-Match with 304", async () => {
    const t = makeBackend();
    await household(t);
    const token = await issue(t);
    const res = await getTimeline(t, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const timeline = (await res.json()) as PhoneTimeline;
    const etag = `"${timeline.version}"`;
    expect(res.headers.get("ETag")).toBe(etag);
    expect(near(timeline.generatedAt, Date.parse(START))).toBe(true);
    expect(timeline.timezone).toBe("America/New_York");
    expect(timeline.until).toBe(timeline.generatedAt + 24 * 60 * MIN);
    expect(timeline.entries[0]!.at).toBe(timeline.generatedAt);
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const cached = await getTimeline(t, token, { "If-None-Match": header });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
      expect(cached.headers.get("ETag")).toBe(etag);
      expect(cached.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await getTimeline(t, token, { "If-None-Match": '"stale"' })).status).toBe(200);
    setNow(Date.parse(START) + 10 * MIN);
    expect((await getTimeline(t, token, { "If-None-Match": etag })).status).toBe(304);
  });

  test("a confirm changes the version", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    setNow(local("08:00"));
    await t.mutation(internal.scheduler.tickHousehold, {
      householdId: f.householdId,
      now: local("08:00"),
    });
    const before = await readTimeline(t, token);
    await postConfirm(t, token, { instanceId: f.instanceId, pressedAgoMs: 0, via: "widget" });
    const after = await getTimeline(t, token, { "If-None-Match": `"${before.version}"` });
    expect(after.status).toBe(200);
    expect(((await after.json()) as PhoneTimeline).version).not.toBe(before.version);
  });

  test("shares the 120 requests a minute with the other device routes", async () => {
    const t = makeBackend();
    await household(t);
    const token = await issue(t);
    for (let i = 0; i < 60; i++) {
      expect((await getState(t, token)).status).toBe(200);
      expect((await getTimeline(t, token)).status).toBe(200);
    }
    const limited = await getTimeline(t, token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect((await getState(t, token)).status).toBe(429);
  });

  test("lists the day's changes with the task's own words", async () => {
    const t = makeBackend();
    const f = await household(t);
    await addPhoneDay(f);
    const token = await issue(t);
    const timeline = await readTimeline(t, token);
    const ready = await instanceIdOf(f, "Get ready");
    expect(timeline.entries.map((e) => e.at)).toEqual([
      timeline.generatedAt,
      local("08:00"),
      local("09:00"),
      local("10:00"),
      local("12:00"),
      local("13:00"),
      local("00:00", "2026-11-14"),
    ]);
    expect(timeline.entries[1]!.cards).toEqual([
      {
        kind: "task",
        instanceId: f.instanceId,
        step: 0,
        stepCount: 1,
        stepText: null,
        label: "Morning pills",
        sentence: "Take your morning pills.",
        detail: "1 white tablet",
        icon: "pills",
        startsAt: local("08:00"),
        endsAt: local("09:00"),
      },
      expect.objectContaining({ instanceId: ready, step: 0, stepCount: 2, stepText: "Shower" }),
      expect.objectContaining({ instanceId: ready, step: 1, stepCount: 2, stepText: "Dress" }),
      { kind: "clear", allDone: false, next: { label: "Lunch pills", startsAt: local("12:00") } },
    ]);
    expect(timeline.entries.at(-1)!.cards).toEqual([
      {
        kind: "clear",
        allDone: false,
        next: { label: "Morning pills", startsAt: local("08:00", "2026-11-14") },
      },
    ]);
  });

  test("predicts what the scheduler and the device state say at each change", async () => {
    const t = makeBackend();
    const f = await household(t);
    await addPhoneDay(f);
    const token = await issue(t);
    const predicted = await readTimeline(t, token);
    expect(firstCardAgrees(await readState(t, token), predicted.entries[0]!.cards)).toBe(true);
    for (let i = 1; i < predicted.entries.length; i++) {
      const entry = predicted.entries[i]!;
      for (const [now, cards] of [
        [entry.at - MIN, predicted.entries[i - 1]!.cards],
        [entry.at, entry.cards],
      ] as const) {
        setNow(now);
        await t.mutation(internal.scheduler.tickHousehold, { householdId: f.householdId, now });
        expect(firstCardAgrees(await readState(t, token), cards), new Date(now).toISOString()).toBe(
          true,
        );
        expect((await readTimeline(t, token)).entries[0]!.cards).toEqual(cards);
      }
    }
  });
});

describe("POST /device/confirm from the widget", () => {
  async function dueAtEight(): Promise<{ f: Fixture; token: string }> {
    const t = makeBackend();
    const f = await household(t);
    await addPhoneDay(f);
    const token = await issue(t);
    setNow(local("08:05"));
    await t.mutation(internal.scheduler.tickHousehold, {
      householdId: f.householdId,
      now: local("08:05"),
    });
    return { f, token };
  }

  async function press(
    f: Fixture,
    token: string,
    instanceId: string,
    step?: number,
  ): Promise<{ status: string; reason: string | null }> {
    const res = await postConfirm(f.t, token, { instanceId, pressedAgoMs: 0, via: "widget", step });
    expect(res.status).toBe(200);
    const { status, reason } = (await res.json()) as { status: string; reason: string | null };
    return { status, reason };
  }

  test("confirms each card in turn, and the timeline moves to the next card", async () => {
    const { f, token } = await dueAtEight();
    const ready = await instanceIdOf(f, "Get ready");
    const firstCard = async () => (await readTimeline(f.t, token)).entries[0]!.cards[0]!;
    expect(await firstCard()).toMatchObject({ instanceId: f.instanceId, step: 0 });
    expect(await press(f, token, f.instanceId, 0)).toEqual({ status: "confirmed", reason: null });
    expect(await firstCard()).toMatchObject({ instanceId: ready, step: 0 });
    expect(await press(f, token, ready, 0)).toEqual({ status: "advanced", reason: null });
    expect(await firstCard()).toMatchObject({ instanceId: ready, step: 1 });
    expect(await press(f, token, ready, 1)).toEqual({ status: "confirmed", reason: null });
    expect(await firstCard()).toEqual({
      kind: "clear",
      allDone: false,
      next: { label: "Lunch pills", startsAt: local("12:00") },
    });
    const row = await f.t.run(async (ctx) => await ctx.db.get(ready));
    expect(row).toMatchObject({ state: "confirmed", confirmedVia: "widget", currentStep: 1 });
  });

  test("a repeated press changes nothing", async () => {
    const { f, token } = await dueAtEight();
    const ready = await instanceIdOf(f, "Get ready");
    expect(await press(f, token, ready, 0)).toEqual({ status: "advanced", reason: null });
    expect(await press(f, token, ready, 0)).toEqual({ status: "advanced", reason: null });
    expect((await f.t.run(async (ctx) => await ctx.db.get(ready)))!.currentStep).toBe(1);
    expect(await press(f, token, f.instanceId, 0)).toEqual({ status: "confirmed", reason: null });
    const confirmed = await f.t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(await press(f, token, f.instanceId, 0)).toEqual({ status: "confirmed", reason: null });
    expect(await f.t.run(async (ctx) => await ctx.db.get(f.instanceId))).toEqual(confirmed);
  });

  test("is accepted inside the early hour and refused before it", async () => {
    const { f, token } = await dueAtEight();
    const lunch = await instanceIdOf(f, "Lunch pills");
    setNow(local("10:55"));
    expect(await press(f, token, lunch)).toEqual({
      status: "rejected",
      reason: "This task is not due yet",
    });
    setNow(local("11:30"));
    expect(
      await (
        await postConfirm(f.t, token, { instanceId: lunch, pressedAgoMs: 0, via: "button" })
      ).json(),
    ).toMatchObject({ status: "rejected", reason: "This task is not due yet" });
    expect(await press(f, token, lunch)).toEqual({ status: "confirmed", reason: null });
    expect((await f.t.run(async (ctx) => await ctx.db.get(lunch)))!.state).toBe("confirmed");
  });
});

describe("POST /device/confirm", () => {
  test("records the press id it was sent with", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t);
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via: "widget",
      pressId: PRESS_A,
    });
    expect(res.status).toBe(200);
    const row = await t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(row).toMatchObject({ state: "confirmed", confirmPressIds: [PRESS_A] });
    const change = (await audits(t)).find((a) => a.action === "state_change");
    expect(change!.detail).toMatchObject({ pressId: PRESS_A, transport: "device_api" });
  });

  test("a press id that is not one is 400 and the task is left alone", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t);
    for (const pressId of ["short", 7, "has spaces in the id!"]) {
      const res = await postConfirm(t, token, {
        instanceId: f.instanceId,
        pressedAgoMs: 0,
        via: "widget",
        pressId,
      });
      expect(res.status).toBe(400);
    }
    expect((await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.state).toBe("due");
  });

  test("each answer carries the device's count of answered presses, and so does its day view", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t);
    const phone = t.withIdentity({ subject: "phone" });
    const dayCount = async (as = phone) =>
      (await as.query(api.calendar.dayView, { householdId: f.householdId })).answeredPresses;
    expect(await dayCount()).toBe(0);
    const countOf = async (res: Response) =>
      ((await res.json()) as { answeredPresses: number }).answeredPresses;
    const press = { instanceId: f.instanceId, pressedAgoMs: 0, via: "widget", pressId: PRESS_A };
    expect(await countOf(await postConfirm(t, token, press))).toBe(1);
    expect(await dayCount()).toBe(1);
    expect(await countOf(await postConfirm(t, token, press))).toBe(2);
    const undo = { instanceId: f.instanceId, pressId: PRESS_A, undoneAgoMs: 0 };
    expect(await countOf(await postUndo(t, token, undo))).toBe(3);
    expect(await countOf(await postUndo(t, token, undo))).toBe(4);
    expect(await dayCount()).toBe(4);
    expect(await dayCount(t.withIdentity({ subject: "pat" }))).toBeNull();
    expect((await postConfirm(t, token, { ...press, instanceId: "abc" })).status).toBe(400);
    expect(await dayCount()).toBe(4);
  });

  test("confirms as the device and returns the fresh state with its ETag", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t);
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via: "widget",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      reason: string | null;
      state: { version: string; done: unknown; rows: { mark: string }[] };
    };
    expect(body.status).toBe("confirmed");
    expect(body.reason).toBeNull();
    expect(body.state.done).toBeNull();
    expect(body.state.rows.map((r) => r.mark)).toEqual(["done"]);
    expect(res.headers.get("ETag")).toBe(`"${body.state.version}"`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const row = await t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(row).toMatchObject({ state: "confirmed", confirmedVia: "widget", confirmedBy: "phone" });
    const change = (await audits(t)).find((a) => a.action === "state_change");
    expect(change).toMatchObject({
      actorKind: "senior_device",
      actorUserId: "phone",
      entityId: f.instanceId,
      detail: { from: "due", to: "confirmed", via: "widget" },
    });
  });

  test("a press stands when the state cannot be read afterwards: state is null", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due", windowStart: local("06:50") });
    const token = await issue(t);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.run(async (ctx) => await ctx.db.delete(f.householdId));
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via: "button",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "confirmed",
      reason: null,
      answeredPresses: 1,
      state: null,
    });
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const row = await t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(row).toMatchObject({ state: "confirmed", confirmedBy: "phone" });
    expect((await audits(t)).some((a) => a.action === "state_change")).toBe(true);
  });

  test("a press of a missed instance and of an anytime instance by id is confirmed", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "missed" });
    await t.withIdentity({ subject: "pat" }).mutation(api.tasks.create, {
      householdId: f.householdId,
      type: "routine",
      title: "Water the plants",
      displayLabel: "Water the plants",
      times: [],
    });
    const anytime = await t.run(async (ctx) =>
      (await ctx.db.query("taskInstances").collect()).find((i) => i.scheduledTime === "anytime"),
    );
    const token = await issue(t);
    for (const instanceId of [f.instanceId, anytime!._id]) {
      const res = await postConfirm(t, token, { instanceId, pressedAgoMs: 0, via: "button" });
      expect(((await res.json()) as { status: string }).status).toBe("confirmed");
      const row = await t.run(async (ctx) => await ctx.db.get(instanceId));
      expect(row!.state).toBe("confirmed");
    }
  });

  test("a replayed press is recorded at the press time, as a late sync", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t);
    setNow(local("08:30"));
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 20 * MIN,
      via: "button",
    });
    expect(((await res.json()) as { status: string }).status).toBe("confirmed");
    const row = await t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(near(row!.confirmedAt, local("08:10"))).toBe(true);
    expect(near(row!.confirmReceivedAt, local("08:30"))).toBe(true);
  });

  test("a replayed press from before the early window is refused and audited", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    setNow(local("07:30"));
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 40 * MIN,
      via: "widget",
    });
    expect(await res.json()).toMatchObject({
      status: "rejected",
      reason: "This task was not due yet when it was pressed",
    });
    expect((await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.state).toBe("upcoming");
    expect((await audits(t)).some((a) => a.action === "press_not_applied")).toBe(true);
  });

  test("a replayed press long after the window is refused", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "missed" });
    const token = await issue(t);
    const windowEnd = (await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.windowEnd;
    setNow(windowEnd + 4 * 60 * MIN);
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 10 * MIN,
      via: "button",
    });
    expect(await res.json()).toMatchObject({
      status: "rejected",
      reason: "This press was too long after the task's window",
    });
    expect((await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.state).toBe("missed");
  });

  test("a deleted instance is rejected, audited, and the state still returned", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    await t.run(async (ctx) => await ctx.db.delete(f.instanceId));
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via: "button",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; reason: string; state: unknown };
    expect(body).toMatchObject({ status: "rejected", reason: "The task no longer exists" });
    expect(body.state).toBeTruthy();
    const audits = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(audits.some((a) => a.action === "press_not_applied")).toBe(true);
  });

  test("another household's instance is answered like a deleted one and left alone", async () => {
    const t = makeBackend();
    const mine = await household(t);
    const theirs = await household(t, "z_");
    await force(theirs, { state: "due" });
    const token = await issue(t);
    const press = { pressedAgoMs: 0, via: "button" };
    const foreign = await postConfirm(t, token, { instanceId: theirs.instanceId, ...press });
    await t.run(async (ctx) => await ctx.db.delete(mine.instanceId));
    const deleted = await postConfirm(t, token, { instanceId: mine.instanceId, ...press });
    expect(foreign.status).toBe(deleted.status);
    const foreignBody = await verdict(foreign);
    const deletedBody = await verdict(deleted);
    expect(foreignBody).toEqual(deletedBody);
    expect(foreignBody).toEqual({ status: "rejected", reason: "The task no longer exists" });
    const theirRow = await t.run(async (ctx) => await ctx.db.get(theirs.instanceId));
    expect(theirRow!.state).toBe("due");
    expect(theirRow!.confirmedAt).toBeUndefined();
    const all = await audits(t);
    expect(
      all.filter((a) => a.householdId === theirs.householdId && a.actorKind === "senior_device"),
    ).toEqual([]);
    const refused = all.filter(
      (a) => a.householdId === mine.householdId && a.action === "press_not_applied",
    );
    expect(refused).toHaveLength(2);
    const foreignRow = refused.find(
      (a) => (a.detail as { reason: string }).reason === "The task is not in this household",
    );
    expect(foreignRow).toMatchObject({ actorKind: "senior_device", actorUserId: "phone" });
    expect(foreignRow!.entityId).toBeUndefined();
    expect(JSON.stringify(foreignRow)).not.toContain(theirs.instanceId);
  });

  test("a bad body or instance id is 400", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    const good = { instanceId: f.instanceId, pressedAgoMs: 0, via: "widget" };
    const bad: unknown[] = [
      "{nope",
      "[]",
      { ...good, instanceId: undefined },
      { ...good, instanceId: "" },
      { ...good, instanceId: "zzz-malformed" },
      { ...good, instanceId: f.phoneId },
      { ...good, pressedAgoMs: -1 },
      { ...good, pressedAgoMs: 7 * 24 * 60 * MIN + 1 },
      { ...good, pressedAgoMs: 1e300 },
      { ...good, pressedAgoMs: "5" },
      { ...good, via: "voice" },
      { ...good, via: "caregiver" },
      { ...good, extra: true },
    ];
    for (const body of bad) {
      const res = await postConfirm(t, token, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
    }
    const row = await t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(row!.state).toBe("upcoming");
    const refused = (await audits(t)).filter((a) => a.action === "press_not_applied");
    expect(refused).toHaveLength(bad.length);
    const details = refused.map((a) => a.detail as Record<string, unknown>);
    expect(new Set(details.map((d) => d.reason))).toEqual(
      new Set(["The press could not be read", "The task id is not valid", "The press is too old"]),
    );
    expect(details.filter((d) => d.reason === "The task id is not valid")).toHaveLength(4);
    expect(details.find((d) => d.reason === "The press is too old")).toMatchObject({
      pressedAgoMs: 7 * 24 * 60 * MIN + 1,
      via: "widget",
    });
    for (const a of refused) {
      expect(a).toMatchObject({ actorKind: "senior_device", actorUserId: "phone" });
      expect(JSON.stringify(a.detail)).not.toContain("zzz");
      expect(JSON.stringify(a.detail)).not.toContain(f.phoneId);
    }
  });

  test("refused presses are audited 20 an hour per device, then answered without a row", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    const malformed = { instanceId: "abc", pressedAgoMs: 0, via: "button" };
    const refusedRows = async (): Promise<number> =>
      (await audits(t)).filter((a) => a.action === "press_not_applied").length;
    for (let i = 0; i < 20; i++) expect((await postConfirm(t, token, malformed)).status).toBe(400);
    expect(await refusedRows()).toBe(20);
    expect((await postConfirm(t, token, malformed)).status).toBe(400);
    const early = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 10 * MIN,
      via: "widget",
    });
    expect(await early.json()).toMatchObject({
      status: "rejected",
      reason: "This task was not due yet when it was pressed",
    });
    expect(await refusedRows()).toBe(20);
    const valid = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via: "widget",
    });
    expect(((await valid.json()) as { status: string }).status).toBe("confirmed");
    await t.run(async (ctx) => await ctx.db.delete(f.instanceId));
    const deleted = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via: "button",
    });
    expect(await deleted.json()).toMatchObject({
      status: "rejected",
      reason: "The task no longer exists",
    });
    expect(await refusedRows()).toBe(20);
    setNow(Date.parse(START) + 4 * MIN);
    expect((await postConfirm(t, token, malformed)).status).toBe(400);
    expect(await refusedRows()).toBe(21);
  });
});

describe("the refused-press budget", () => {
  test("refusals the core records spend it too", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    await t.run(async (ctx) => await ctx.db.delete(f.instanceId));
    const deleted = { instanceId: f.instanceId, pressedAgoMs: 0, via: "button" };
    for (let i = 0; i < 20; i++) await postConfirm(t, token, deleted);
    const refusedRows = async (): Promise<number> =>
      (await audits(t)).filter((a) => a.action === "press_not_applied").length;
    expect(await refusedRows()).toBe(20);
    expect(
      (await postConfirm(t, token, { instanceId: "abc", pressedAgoMs: 0, via: "button" })).status,
    ).toBe(400);
    expect(await refusedRows()).toBe(20);
  });

  test("successful confirms do not spend it", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due", windowStart: local("06:50") });
    const token = await issue(t);
    const press = { instanceId: f.instanceId, pressedAgoMs: 0, via: "button" };
    for (let i = 0; i < 25; i++) {
      const res = await postConfirm(t, token, press);
      expect(((await res.json()) as { status: string }).status).toBe("confirmed");
    }
    await postConfirm(t, token, { instanceId: "abc", pressedAgoMs: 0, via: "button" });
    const refused = (await audits(t)).filter((a) => a.action === "press_not_applied");
    expect(refused).toHaveLength(1);
  });

  test("with it spent, a press on another household's instance writes no row", async () => {
    const t = makeBackend();
    await household(t);
    const theirs = await household(t, "z_");
    const token = await issue(t);
    const malformed = { instanceId: "abc", pressedAgoMs: 0, via: "button" };
    for (let i = 0; i < 20; i++) await postConfirm(t, token, malformed);
    const refusedRows = async (): Promise<number> =>
      (await audits(t)).filter((a) => a.action === "press_not_applied").length;
    expect(await refusedRows()).toBe(20);
    const res = await postConfirm(t, token, {
      instanceId: theirs.instanceId,
      pressedAgoMs: 0,
      via: "button",
    });
    expect(await res.json()).toMatchObject({
      status: "rejected",
      reason: "The task no longer exists",
    });
    expect(await refusedRows()).toBe(20);
  });
});

describe("errors the core does not turn into a rejection", () => {
  test("propagate from the confirm mutation instead of reading as a missing task", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    const tokenHash = await hashDeviceToken(token);
    await expect(
      t.mutation(internal.deviceApi.confirmByToken, {
        tokenHash,
        instanceId: f.instanceId,
        via: "button",
        pressedAgoMs: -1,
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    expect((await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.state).toBe("upcoming");
    expect((await audits(t)).some((a) => a.action === "press_not_applied")).toBe(false);
  });
});

describe("isolation from another household", () => {
  test("its instance in any state is answered like a deleted one, unchanged and unrecorded", async () => {
    const t = makeBackend();
    const mine = await household(t);
    const theirs = await household(t, "z_");
    const token = await issue(t);
    const press = { pressedAgoMs: 0, via: "button" };
    await t.run(async (ctx) => await ctx.db.delete(mine.instanceId));
    const reference = await postConfirm(t, token, { instanceId: mine.instanceId, ...press });
    const referenceBody = await verdict(reference);
    expect(referenceBody).toEqual({ status: "rejected", reason: "The task no longer exists" });
    const farAhead = Date.parse(START) + 4 * 60 * MIN;
    const cases: Record<string, unknown>[] = [
      {
        state: "confirmed",
        confirmedAt: Date.parse(START) - MIN,
        confirmedBy: "z_phone",
        confirmedVia: "button",
      },
      {
        state: "resolved",
        confirmedAt: Date.parse(START) - MIN,
        confirmedBy: "z_pat",
        confirmedVia: "caregiver",
      },
      { state: "upcoming", windowStart: farAhead, windowEnd: farAhead + 60 * MIN },
      { state: "missed" },
    ];
    const theirRows = async (): Promise<number> =>
      (await audits(t)).filter((a) => a.householdId === theirs.householdId).length;
    for (const patch of cases) {
      await t.run(async (ctx) => await ctx.db.patch(theirs.instanceId, patch));
      const before = await t.run(async (ctx) => await ctx.db.get(theirs.instanceId));
      const rowsBefore = await theirRows();
      const res = await postConfirm(t, token, { instanceId: theirs.instanceId, ...press });
      expect(res.status, String(patch.state)).toBe(reference.status);
      expect(await verdict(res), String(patch.state)).toEqual(referenceBody);
      expect(await t.run(async (ctx) => await ctx.db.get(theirs.instanceId))).toEqual(before);
      expect(await theirRows(), String(patch.state)).toBe(rowsBefore);
    }
    const mineRows = (await audits(t)).filter((a) => a.householdId === mine.householdId);
    for (const row of mineRows) {
      expect(row.entityId).not.toBe(theirs.instanceId);
      expect(JSON.stringify(row.detail ?? {})).not.toContain(theirs.instanceId);
    }
  });
});

describe("the core's refusal row", () => {
  test("carries the transport the press arrived by", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t, "display");
    const early = { instanceId: f.instanceId, pressedAgoMs: 10 * MIN, via: "widget" as const };
    await postConfirm(t, token, early);
    await t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.confirmPressedTask, { ...early, pressId: "pressAAAAAAAAAAAAAAA" });
    const rows = (await audits(t)).filter(
      (a) =>
        a.action === "press_not_applied" &&
        (a.detail as { reason?: string }).reason ===
          "This task was not due yet when it was pressed",
    );
    expect(rows.map((a) => (a.detail as { transport?: string }).transport).sort()).toEqual([
      "app",
      "device_api",
    ]);
  });
});

describe("a confirm through the device API is a device confirm", () => {
  test("every confirm and refusal records how it arrived (transport)", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due", windowStart: local("06:50") });
    const token = await issue(t, "display");
    await postConfirm(t, token, { instanceId: f.instanceId, pressedAgoMs: 0, via: "button" });
    await postConfirm(t, token, { instanceId: "abc", pressedAgoMs: 0, via: "button" });
    const second = await household(t, "z_");
    await force(second, { state: "due" });
    await t.withIdentity({ subject: "z_phone" }).mutation(api.instances.confirmPressedTask, {
      instanceId: second.instanceId,
      via: "phone_app",
      pressedAgoMs: 0,
      pressId: "pressAAAAAAAAAAAAAAA",
    });
    const rows = await audits(t);
    const transportOf = (householdId: Id<"households">, action: string): unknown =>
      (
        rows.find((a) => a.householdId === householdId && a.action === action)?.detail as {
          transport?: unknown;
        }
      )?.transport;
    expect(transportOf(f.householdId, "state_change")).toBe("device_api");
    expect(transportOf(f.householdId, "press_not_applied")).toBe("device_api");
    expect(transportOf(second.householdId, "state_change")).toBe("app");
  });

  test("a caregiver's reopen stamps it, so an older queued press is refused", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t, "display");
    setNow(local("08:05"));
    await postConfirm(t, token, { instanceId: f.instanceId, pressedAgoMs: 0, via: "button" });
    setNow(local("08:06"));
    await t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.reopenTaskInstance, { instanceId: f.instanceId });
    const reopened = await t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(reopened!.state).toBe("due");
    expect(near(reopened!.confirmTakenBackAt, local("08:06"))).toBe(true);
    const stale = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 2 * MIN,
      via: "button",
    });
    expect(await stale.json()).toMatchObject({
      status: "rejected",
      reason: "This press was made before the confirmation was taken back",
    });
    const fresh = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via: "button",
    });
    expect(((await fresh.json()) as { status: string }).status).toBe("confirmed");
  });

  test("a press sent without a press id cannot be undone", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t, "phone");
    setNow(local("08:05"));
    await postConfirm(t, token, { instanceId: f.instanceId, pressedAgoMs: 0, via: "widget" });
    setNow(local("08:05") + 20_000);
    const undone = await t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.undoPressedTask, {
        instanceId: f.instanceId,
        pressId: "pressAAAAAAAAAAAAAAA",
      });
    expect(undone.status).toBe("too_late");
    expect((await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.state).toBe("confirmed");
  });
});

describe("POST /device/undo", () => {
  async function pressed(via = "widget"): Promise<{ t: TestConvex; f: Fixture; token: string }> {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t);
    setNow(local("08:05"));
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via,
      pressId: PRESS_A,
    });
    expect(((await res.json()) as { status: string }).status).toBe("confirmed");
    return { t, f, token };
  }

  async function instance(f: Fixture) {
    return (await f.t.run(async (ctx) => await ctx.db.get(f.instanceId)))!;
  }

  test("takes back a press made through the API and returns the fresh state", async () => {
    const { t, f, token } = await pressed();
    setNow(local("08:05") + 20_000);
    const res = await postUndo(t, token, {
      instanceId: f.instanceId,
      pressId: PRESS_A,
      undoneAgoMs: 0,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      state: { version: string; done: { instanceId: string } | null };
    };
    expect(body.status).toBe("undone");
    expect(body.state.done?.instanceId).toBe(f.instanceId);
    expect(res.headers.get("ETag")).toBe(`"${body.state.version}"`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await instance(f)).toMatchObject({ state: "due", takenBackPressIds: [PRESS_A] });
    const change = (await audits(t)).filter((a) => a.action === "state_change").at(-1);
    expect(change).toMatchObject({
      actorKind: "senior_device",
      actorUserId: "phone",
      detail: {
        from: "confirmed",
        to: "due",
        undo: true,
        pressId: PRESS_A,
        transport: "device_api",
      },
    });
  });

  test("a press from the widget, the Live Activity or the app is undone the same way", async () => {
    for (const via of ["widget", "live_activity", "phone_app"]) {
      const { t, f, token } = await pressed(via);
      const res = await postUndo(t, token, {
        instanceId: f.instanceId,
        pressId: PRESS_A,
        undoneAgoMs: 0,
      });
      expect(((await res.json()) as { status: string }).status).toBe("undone");
      expect((await instance(f)).state).toBe("due");
    }
  });

  test("a press and its Undo made offline are judged from when they were tapped", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t);
    setNow(local("09:00"));
    await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 55 * MIN,
      via: "widget",
      pressId: PRESS_A,
    });
    expect(near((await instance(f)).confirmedAt, local("08:05"))).toBe(true);
    const res = await postUndo(t, token, {
      instanceId: f.instanceId,
      pressId: PRESS_A,
      undoneAgoMs: 55 * MIN - 20_000,
    });
    expect(((await res.json()) as { status: string }).status).toBe("undone");
    expect((await instance(f)).state).not.toBe("confirmed");
    const again = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 55 * MIN,
      via: "widget",
      pressId: PRESS_A,
    });
    expect(await again.json()).toMatchObject({
      status: "rejected",
      reason: "This press was taken back",
    });
  });

  test("a repeat of an applied Undo answers undone again, changes nothing and audits nothing", async () => {
    const { t, f, token } = await pressed();
    const undo = { instanceId: f.instanceId, pressId: PRESS_A, undoneAgoMs: 0 };
    setNow(local("08:05") + 20_000);
    expect(((await (await postUndo(t, token, undo)).json()) as { status: string }).status).toBe(
      "undone",
    );
    const undone = await instance(f);
    const auditCount = (await audits(t)).length;
    setNow(local("08:05") + 2 * MIN);
    const again = await postUndo(t, token, undo);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("undone");
    expect(await instance(f)).toEqual(undone);
    expect((await audits(t)).length).toBe(auditCount);
    expect((await audits(t)).some((a) => a.action === "undo_not_applied")).toBe(false);
  });

  test("a repeat of an applied step Undo answers undone again and leaves the step alone", async () => {
    const t = makeBackend();
    const f = await household(t);
    await addPhoneDay(f);
    const token = await issue(t);
    setNow(local("08:05"));
    await t.mutation(internal.scheduler.tickHousehold, {
      householdId: f.householdId,
      now: local("08:05"),
    });
    const ready = await instanceIdOf(f, "Get ready");
    const row = async () => (await t.run(async (ctx) => await ctx.db.get(ready)))!;
    const press = { instanceId: ready, pressedAgoMs: 0, via: "widget", step: 0, pressId: PRESS_A };
    expect(((await (await postConfirm(t, token, press)).json()) as { status: string }).status).toBe(
      "advanced",
    );
    const undo = { instanceId: ready, pressId: PRESS_A, undoneAgoMs: 0 };
    setNow(local("08:05") + 10_000);
    expect(((await (await postUndo(t, token, undo)).json()) as { status: string }).status).toBe(
      "undone",
    );
    const steppedBack = await row();
    expect(steppedBack.currentStep).toBe(0);
    const auditCount = (await audits(t)).length;
    setNow(local("08:05") + 2 * MIN);
    expect(((await (await postUndo(t, token, undo)).json()) as { status: string }).status).toBe(
      "undone",
    );
    expect(await row()).toEqual(steppedBack);
    expect((await audits(t)).length).toBe(auditCount);
    expect((await audits(t)).some((a) => a.action === "undo_not_applied")).toBe(false);
  });

  test("an Undo tapped more than a minute after the press is too late and audited", async () => {
    const { t, f, token } = await pressed();
    setNow(local("08:05") + 61_000);
    const res = await postUndo(t, token, {
      instanceId: f.instanceId,
      pressId: PRESS_A,
      undoneAgoMs: 0,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("too_late");
    expect((await instance(f)).state).toBe("confirmed");
    const refusal = (await audits(t)).find((a) => a.action === "undo_not_applied");
    expect(refusal!.detail).toMatchObject({ pressId: PRESS_A, transport: "device_api" });
  });

  test("an Undo that names another press, or comes from another device, changes nothing", async () => {
    const { t, f, token } = await pressed();
    const other = await postUndo(t, token, {
      instanceId: f.instanceId,
      pressId: PRESS_B,
      undoneAgoMs: 0,
    });
    expect(((await other.json()) as { status: string }).status).toBe("too_late");
    const displayToken = await issue(t, "display");
    const fromDisplay = await postUndo(t, displayToken, {
      instanceId: f.instanceId,
      pressId: PRESS_A,
      undoneAgoMs: 0,
    });
    expect(((await fromDisplay.json()) as { status: string }).status).toBe("too_late");
    expect((await instance(f)).state).toBe("confirmed");
  });

  test("another household's instance is answered like a missing one and left alone", async () => {
    const { t, f } = await pressed();
    await household(t, "z_");
    const foreignToken = await issue(t, "z_phone");
    const res = await postUndo(t, foreignToken, {
      instanceId: f.instanceId,
      pressId: PRESS_A,
      undoneAgoMs: 0,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("too_late");
    expect((await instance(f)).state).toBe("confirmed");
    const refusal = (await audits(t)).find((a) => a.action === "undo_not_applied");
    expect(refusal).toMatchObject({
      actorUserId: "z_phone",
      detail: { reason: "The task is not in this household", pressId: PRESS_A },
    });
    expect(refusal!.householdId).not.toBe(f.householdId);
  });

  test("a bad body, press id or instance id is 400 and audited", async () => {
    const { t, f, token } = await pressed();
    const good = { instanceId: f.instanceId, pressId: PRESS_A, undoneAgoMs: 0 };
    const bad: unknown[] = [
      "{nope",
      [],
      { ...good, extra: 1 },
      { ...good, instanceId: "" },
      { ...good, instanceId: "abc" },
      { ...good, pressId: "short" },
      { instanceId: f.instanceId, undoneAgoMs: 0 },
      { ...good, undoneAgoMs: -1 },
      { ...good, undoneAgoMs: "0" },
      { ...good, undoneAgoMs: 8 * 24 * 60 * MIN },
    ];
    for (const body of bad) expect((await postUndo(t, token, body)).status).toBe(400);
    expect((await instance(f)).state).toBe("confirmed");
    const refusals = (await audits(t)).filter((a) => a.action === "undo_not_applied");
    expect(refusals).toHaveLength(bad.length);
    expect(
      refusals.every((a) => (a.detail as { transport: string }).transport === "device_api"),
    ).toBe(true);
  });

  test("refused Undos share the 20 audited refusals an hour with refused presses", async () => {
    const { t, f, token } = await pressed();
    for (let i = 0; i < 25; i += 1) {
      const res = await postUndo(t, token, {
        instanceId: f.instanceId,
        pressId: PRESS_B,
        undoneAgoMs: 0,
      });
      expect(((await res.json()) as { status: string }).status).toBe("too_late");
    }
    expect((await audits(t)).filter((a) => a.action === "undo_not_applied")).toHaveLength(20);
    const late = await postConfirm(t, token, {
      instanceId: "abc",
      pressedAgoMs: 0,
      via: "widget",
    });
    expect(late.status).toBe(400);
    expect((await audits(t)).some((a) => a.action === "press_not_applied")).toBe(false);
  });
});

describe("revokeDeviceToken", () => {
  test("an editor revokes the token; the device stays paired and is issued no new one", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    await t.withIdentity({ subject: "pat" }).mutation(api.households.revokeDeviceToken, {
      householdId: f.householdId,
      deviceId: f.phoneId,
    });
    expect((await getState(t, token)).status).toBe(401);
    const row = await deviceRow(t, f.phoneId);
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBeUndefined();
    expect(row!.tokenIssuedAt).toBeUndefined();
    expect(near(row!.tokenRevokedAt, Date.parse(START))).toBe(true);
    expect((await audits(t)).find((a) => a.action === "revoke_device_token")).toMatchObject({
      actorKind: "caregiver",
      actorUserId: "pat",
      entityId: f.phoneId,
      detail: { hadToken: true },
    });
    await expect(issue(t)).rejects.toThrow(/Pair the device again/);
    setNow(Date.parse(START) + 2 * 60 * MIN);
    await expect(issue(t)).rejects.toThrow(/Pair the device again/);
    expect((await deviceRow(t, f.phoneId))!.tokenHash).toBeUndefined();
    expect((await audits(t)).filter((a) => a.action === "issue_device_token")).toHaveLength(1);
  });

  test("caregivers see since when a device's token is revoked", async () => {
    const t = makeBackend();
    const f = await household(t);
    const asPat = t.withIdentity({ subject: "pat" });
    const listed = async () =>
      (await asPat.query(api.households.listDevices, { householdId: f.householdId })).find(
        (d) => d._id === f.phoneId,
      )!;
    expect((await listed()).tokenRevokedAt).toBeUndefined();
    await asPat.mutation(api.households.revokeDeviceToken, {
      householdId: f.householdId,
      deviceId: f.phoneId,
    });
    expect(near((await listed()).tokenRevokedAt, Date.parse(START))).toBe(true);
  });

  test("the phone paired again is issued a token while the revoked pairing stays refused", async () => {
    const t = makeBackend();
    const f = await household(t);
    await issue(t);
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.revokeDeviceToken, {
      householdId: f.householdId,
      deviceId: f.phoneId,
    });
    const { code } = await pat.mutation(api.households.createJoinCode, {
      householdId: f.householdId,
      grants: "senior_phone",
    });
    const paired = await t.mutation(internal.households.pairDevice, { code, userId: "phone-2" });
    expect(paired.deviceId).not.toBe(f.phoneId);
    const token = await issue(t, "phone-2");
    expect((await getState(t, token)).status).toBe(200);
    expect((await deviceRow(t, paired.deviceId))!.tokenRevokedAt).toBeUndefined();
    await expect(issue(t)).rejects.toThrow(/Pair the device again/);
  });

  test("a viewer, a device and another household's editor are refused", async () => {
    const t = makeBackend();
    const f = await household(t);
    const theirs = await household(t, "z_");
    const { code } = await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.createJoinCode, {
        householdId: f.householdId,
        grants: "caregiver_viewer",
      });
    await t.withIdentity({ subject: "val" }).mutation(api.households.redeemJoinCode, { code });
    const token = await issue(t);
    const args = { householdId: f.householdId, deviceId: f.phoneId };
    for (const subject of ["val", "phone", "z_pat"]) {
      await expect(
        t.withIdentity({ subject }).mutation(api.households.revokeDeviceToken, args),
      ).rejects.toThrow(/Not allowed/);
    }
    await expect(
      t.withIdentity({ subject: "pat" }).mutation(api.households.revokeDeviceToken, {
        householdId: f.householdId,
        deviceId: theirs.phoneId,
      }),
    ).rejects.toThrow(/Device not found/);
    expect((await getState(t, token)).status).toBe(200);
  });
});

describe("revokeOwnToken", () => {
  test("an unpaired phone that pairs again is issued a token", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    await t.withIdentity({ subject: "phone" }).mutation(api.deviceApi.revokeOwnToken, {});
    expect((await getState(t, token)).status).toBe(401);
    expect((await deviceRow(t, f.phoneId))!.tokenRevokedAt).toBeUndefined();
    const { code } = await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.createJoinCode, {
        householdId: f.householdId,
        grants: "senior_phone",
      });
    await t.mutation(internal.households.pairDevice, { code, userId: "phone-2" });
    expect((await getState(t, await issue(t, "phone-2"))).status).toBe(200);
  });

  test("a paired phone revokes its own token and stays paired", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    await t.withIdentity({ subject: "phone" }).mutation(api.deviceApi.revokeOwnToken, {});
    expect((await getState(t, token)).status).toBe(401);
    const row = await deviceRow(t, f.phoneId);
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBeUndefined();
    expect(row!.tokenIssuedAt).toBeUndefined();
    expect((await audits(t)).filter((a) => a.action === "revoke_device_token")).toEqual([
      expect.objectContaining({
        householdId: f.householdId,
        actorKind: "senior_device",
        actorUserId: "phone",
        entity: "device",
        entityId: f.phoneId,
        detail: { hadToken: true },
      }),
    ]);
    expect((await getState(t, await issue(t))).status).toBe(200);
  });

  test("a second call finds no token and is audited as such", async () => {
    const t = makeBackend();
    await household(t);
    await issue(t);
    const phone = t.withIdentity({ subject: "phone" });
    await phone.mutation(api.deviceApi.revokeOwnToken, {});
    await phone.mutation(api.deviceApi.revokeOwnToken, {});
    expect(
      (await audits(t))
        .filter((a) => a.action === "revoke_device_token")
        .map((a) => (a.detail as { hadToken: boolean }).hadToken),
    ).toEqual([true, false]);
  });

  test("one device's call leaves every other device's token working", async () => {
    const t = makeBackend();
    await household(t);
    const theirs = await household(t, "z_");
    const phoneToken = await issue(t);
    const displayToken = await issue(t, "display");
    const otherPhoneToken = await issue(t, "z_phone");
    await t.withIdentity({ subject: "display" }).mutation(api.deviceApi.revokeOwnToken, {});
    expect((await getState(t, displayToken)).status).toBe(401);
    expect((await getState(t, phoneToken)).status).toBe(200);
    expect((await getState(t, otherPhoneToken)).status).toBe(200);
    expect((await deviceRow(t, theirs.phoneId))!.tokenHash).toBeDefined();
  });

  test("a device may revoke 10 times an hour, then is refused until the bucket refills", async () => {
    const t = makeBackend();
    await household(t);
    const phone = t.withIdentity({ subject: "phone" });
    for (let i = 0; i < 10; i++) await phone.mutation(api.deviceApi.revokeOwnToken, {});
    await expect(phone.mutation(api.deviceApi.revokeOwnToken, {})).rejects.toThrow(
      /Too many device token revokes/,
    );
    expect((await audits(t)).filter((a) => a.action === "revoke_device_token")).toHaveLength(10);
    setNow(Date.parse(START) + 7 * MIN);
    await phone.mutation(api.deviceApi.revokeOwnToken, {});
    expect((await audits(t)).filter((a) => a.action === "revoke_device_token")).toHaveLength(11);
  });

  test("a caregiver and a signed-out caller are refused, and no token is revoked", async () => {
    const t = makeBackend();
    await household(t);
    const token = await issue(t);
    await expect(
      t.withIdentity({ subject: "pat" }).mutation(api.deviceApi.revokeOwnToken, {}),
    ).rejects.toThrow(/Only the senior's devices can do this/);
    await expect(t.mutation(api.deviceApi.revokeOwnToken, {})).rejects.toThrow(/Sign in first/);
    expect((await getState(t, token)).status).toBe(200);
    expect((await audits(t)).filter((a) => a.action === "revoke_device_token")).toEqual([]);
  });
});

describe("a device removed between the gate and the effect", () => {
  test("every by-token function finds nothing and writes nothing", async () => {
    const t = makeBackend();
    const f = await household(t);
    const tokenHash = await hashDeviceToken(UNKNOWN_TOKEN);
    expect(await t.mutation(internal.deviceApi.admit, { tokenHash })).toEqual({ kind: "unknown" });
    expect(await t.query(internal.deviceApi.stateByToken, { tokenHash })).toBeNull();
    expect(await t.query(internal.deviceApi.timelineByToken, { tokenHash })).toBeNull();
    expect(
      await t.mutation(internal.deviceApi.confirmByToken, {
        tokenHash,
        instanceId: f.instanceId,
        via: "button",
        pressedAgoMs: 0,
      }),
    ).toEqual({ kind: "unauthorized" });
    expect(
      await t.mutation(internal.deviceApi.undoByToken, {
        tokenHash,
        instanceId: f.instanceId,
        pressId: PRESS_A,
        undoneAgoMs: 0,
      }),
    ).toEqual({ kind: "unauthorized" });
    expect(
      await t.mutation(internal.deviceApi.updateInfoByToken, { tokenHash, firmware: "1.0" }),
    ).toBe(false);
    await t.mutation(internal.deviceApi.refuseByToken, {
      tokenHash,
      action: "press_not_applied",
      reason: "The press could not be read",
      sent: { pressedAgoMs: null, via: null },
    });
    await t.mutation(internal.deviceApi.refuseByToken, {
      tokenHash,
      action: "undo_not_applied",
      reason: "The undo could not be read",
      sent: { undoneAgoMs: null, pressId: null },
    });
    expect((await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.state).toBe("upcoming");
    expect((await audits(t)).some((a) => a.action.endsWith("_not_applied"))).toBe(false);
    expect((await deviceRow(t, f.phoneId))!.firmware).toBeUndefined();
  });
});

describe("unexpected errors", () => {
  test("an internal failure is a 500 that still carries no-store, on every route", async () => {
    const t = makeBackend();
    await household(t);
    const token = await issue(t);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("boom"));
    for (const res of [
      await getState(t, token),
      await getTimeline(t, token),
      await postConfirm(t, token, {}),
      await postUndo(t, token, {}),
      await putInfo(t, token, {}),
    ]) {
      expect(res.status).toBe(500);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("server_error");
    }
  });
});

describe("request bodies", () => {
  test("a body over 4096 characters is refused before it is parsed", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    const firmware = `1.0${" ".repeat(5000)}`;
    const res = await putInfo(t, token, { firmware });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid", message: "The request body is too large" },
    });
    expect((await deviceRow(t, f.phoneId))!.firmware).toBeUndefined();
  });
});

describe("PUT /device/info", () => {
  test("stores the screen and the trimmed firmware, and answers 204", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    const before = await deviceRow(t, f.phoneId);
    const res = await putInfo(t, token, {
      screen: { width: 800, height: 480, greys: 16 },
      firmware: "  1.2.3  ",
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const after = await deviceRow(t, f.phoneId);
    expect(after).toEqual({
      ...before,
      lastSeenAt: after!.lastSeenAt,
      screen: { width: 800, height: 480, greys: 16 },
      firmware: "1.2.3",
    });
    expect((await putInfo(t, token, { firmware: "1.2.4" })).status).toBe(204);
    expect(await deviceRow(t, f.phoneId)).toMatchObject({
      screen: { width: 800, height: 480, greys: 16 },
      firmware: "1.2.4",
    });
  });

  test("refuses bad values and any other field, changing nothing", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    await putInfo(t, token, {});
    const before = await deviceRow(t, f.phoneId);
    const screen = { width: 800, height: 480, greys: 16 };
    const bad: unknown[] = [
      { screen: { ...screen, width: 0 } },
      { screen: { ...screen, height: 10_001 } },
      { screen: { ...screen, width: 1.5 } },
      { screen: { ...screen, greys: 1 } },
      { screen: { ...screen, greys: 257 } },
      { screen: { width: 800, height: 480 } },
      { screen: { ...screen, depth: 4 } },
      { screen: null },
      { firmware: "x".repeat(41) },
      { firmware: "   " },
      { firmware: 12 },
      { firmware: "1.0\n2" },
      { name: "Kitchen" },
      { householdId: f.householdId },
      { tokenHash: "x" },
      "[]",
    ];
    for (const body of bad) expect((await putInfo(t, token, body)).status).toBe(400);
    expect(await deviceRow(t, f.phoneId)).toEqual(before);
    const edges = { screen: { width: 10_000, height: 1, greys: 256 }, firmware: "x".repeat(40) };
    expect((await putInfo(t, token, edges)).status).toBe(204);
    expect((await putInfo(t, token, { screen: { ...screen, greys: 2 } })).status).toBe(204);
  });
});

describe("lastSeenAt", () => {
  test("is written on an authenticated request at most every 5 minutes", async () => {
    const t = makeBackend();
    const f = await household(t);
    const token = await issue(t);
    const start = Date.parse(START);
    expect((await deviceRow(t, f.phoneId))!.lastSeenAt).toBeUndefined();
    await getState(t, UNKNOWN_TOKEN);
    expect((await deviceRow(t, f.phoneId))!.lastSeenAt).toBeUndefined();
    await getState(t, token);
    const first = (await deviceRow(t, f.phoneId))!.lastSeenAt;
    expect(near(first, start)).toBe(true);
    setNow(start + 2 * MIN);
    await getState(t, token);
    setNow(start + 4 * MIN + 59_000);
    await getState(t, token);
    expect((await deviceRow(t, f.phoneId))!.lastSeenAt).toBe(first);
    setNow(start + 5 * MIN + 1_000);
    await getState(t, token);
    expect(near((await deviceRow(t, f.phoneId))!.lastSeenAt, start + 5 * MIN + 1_000)).toBe(true);
  });
});
