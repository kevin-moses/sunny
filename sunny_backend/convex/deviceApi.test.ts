// convex/deviceApi.test.ts
// Purpose: Tests for the device API (deviceApi.ts) with convex-test and a frozen clock (Date
// only, so the rate limiter's buckets never refill mid-test). Token: issue (format, only the
// hash stored, audited without the token), rotation (the old token gets 401), removal revokes at
// once, the hash never appears in listDevices or any response, the token never in a log line,
// a caregiver or signed-out caller cannot issue, at most 10 issues an hour. Authentication: 401 for missing, malformed and
// unknown tokens with one identical body; the failed-attempt buckets (global and per-IP) turn
// 401 into 429 with Retry-After while a valid token keeps working; the per-device bucket.
// State: ETag and 304 (weak and list forms), the Clerk query and the HTTP route return the same
// object, the query refuses caregivers and signed-out callers, the loader's cues against the
// real scheduler (prompt instants predicted before 08:00 are exactly when the tick sends them)
// and tomorrow's instance inside the 24 hours. Confirm: success (instance confirmed with the
// device's via and user, fresh state and ETag returned), rejected for a deleted instance
// (audited), another household's instance answered exactly like a deleted one and left alone,
// 400 for bad bodies, ids and press ages over 7 days (only after the token is accepted), and
// for a body over 4096 characters. Info: stored and trimmed, 204,
// validation, no other field writable. lastSeenAt written at most every 5 minutes, and not
// for a failed authentication.
//
// Last modified: 2026-11-13

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hashDeviceToken } from "./lib/deviceToken";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const MIN = 60_000;
/** Friday 2026-11-13 at 07:00 in New York (UTC-5). */
const START = "2026-11-13T12:00:00Z";

/**
 * purpose: The instant of a New York wall time (UTC-5 in November).
 * @param hhmm: (string) Local "HH:MM".
 * @param date: (string, optional) Local date; default 2026-11-13.
 * @return: (number) Epoch ms.
 */
function local(hhmm: string, date = "2026-11-13"): number {
  return Date.parse(`${date}T${hhmm}:00-05:00`);
}

/**
 * purpose: Set the frozen clock.
 * @param ms: (number) Epoch ms.
 * @return: (void)
 */
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

/**
 * purpose: A fresh backend with the rate limiter and delivery pool registered.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  workpoolTest.register(t, "deliveryPool");
  return t;
}

/** The harness type. */
type TestConvex = ReturnType<typeof makeBackend>;

/** A household with Pat (primary), a paired phone and display, and an 08:00 medication. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  instanceId: Id<"taskInstances">;
  phoneId: Id<"devices">;
}

/**
 * purpose: Create a household with a caregiver, paired devices and a medication task.
 * @param t: (TestConvex) Harness.
 * @param prefix: (string) Prefix for the user ids, so two households can share a backend.
 * @return: (Promise<Fixture>) The fixture; instanceId is today's 08:00 instance.
 */
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
  const policies = await pat.query(api.tasks.listPolicies, { householdId });
  await pat.mutation(api.tasks.create, {
    householdId,
    type: "medication",
    title: "Morning pills",
    displayLabel: "Morning pills",
    times: ["08:00"],
    escalationPolicyId: policies.find((p) => p.systemKey === "medication")!._id,
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

/**
 * purpose: Issue a device token as a signed-in user.
 * @param t: (TestConvex) Harness.
 * @param subject: (string) The Clerk user id.
 * @return: (Promise<string>) The token.
 */
async function issue(t: TestConvex, subject = "phone"): Promise<string> {
  const { deviceToken } = await t.withIdentity({ subject }).action(api.deviceApi.issueToken, {});
  return deviceToken;
}

/**
 * purpose: Call the device API.
 * @param t: (TestConvex) Harness.
 * @param method: (string) HTTP method.
 * @param path: (string) Route.
 * @param options: ({ token, body, headers }) A token (null sends no Authorization), a JSON body
 *        or raw string, extra headers.
 * @return: (Promise<Response>) The response.
 */
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

/**
 * purpose: GET /device/state.
 * @param t: (TestConvex) Harness.
 * @param token: (string | null) The token.
 * @param headers: (Record<string, string>, optional) Extra headers.
 * @return: (Promise<Response>) The response.
 */
async function getState(
  t: TestConvex,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await call(t, "GET", "/device/state", { token, headers });
}

/**
 * purpose: POST /device/confirm.
 * @param t: (TestConvex) Harness.
 * @param token: (string) The token.
 * @param body: (unknown) The body.
 * @return: (Promise<Response>) The response.
 */
async function postConfirm(t: TestConvex, token: string, body: unknown): Promise<Response> {
  return await call(t, "POST", "/device/confirm", { token, body });
}

/**
 * purpose: PUT /device/info.
 * @param t: (TestConvex) Harness.
 * @param token: (string) The token.
 * @param body: (unknown) The body.
 * @return: (Promise<Response>) The response.
 */
async function putInfo(t: TestConvex, token: string, body: unknown): Promise<Response> {
  return await call(t, "PUT", "/device/info", { token, body });
}

/**
 * purpose: Read a device row.
 * @param t: (TestConvex) Harness.
 * @param deviceId: (Id<"devices">) The device.
 * @return: The row, or null.
 */
async function deviceRow(t: TestConvex, deviceId: Id<"devices">) {
  return await t.run(async (ctx) => await ctx.db.get(deviceId));
}

/**
 * purpose: Force an instance's fields (the scheduler is not run unless a test runs it).
 * @param f: (Fixture) Fixture.
 * @param patch: (Record<string, unknown>) Fields to set.
 * @return: (Promise<void>)
 */
async function force(f: Fixture, patch: Record<string, unknown>): Promise<void> {
  await f.t.run(async (ctx) => await ctx.db.patch(f.instanceId, patch));
}

/**
 * purpose: Whether a stored instant is the expected one (convex-test may advance the clock a
 *          few milliseconds inside a function).
 * @param actual: (number | undefined) The stored instant.
 * @param expected: (number) The expected instant.
 * @return: (boolean) True within 100 ms.
 */
function near(actual: number | undefined, expected: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) < 100;
}

/** A well-formed token no device holds. */
const UNKNOWN_TOKEN = `sunny_dev_${"Q".repeat(43)}`;

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
    // Pressing another household's task logs a warning; it must not carry the token either.
    const theirs = await household(t, "z_");
    await postConfirm(t, token, { instanceId: theirs.instanceId, pressedAgoMs: 0, via: "widget" });
    expect(logged.some((line) => line.includes("another household"))).toBe(true);
    expect(logged.some((line) => line.includes(token) || line.includes(hash))).toBe(false);
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
    expect(viaQuery.done).toEqual({ instanceId: f.instanceId, early: false });
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
    /**
     * purpose: Run the household's tick and read how many prompts the instance has had.
     * @param now: (number) Epoch ms.
     * @return: (Promise<number>) seniorPrompts after the tick.
     */
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

describe("POST /device/confirm", () => {
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
    const row = await t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(row).toMatchObject({ state: "confirmed", confirmedVia: "widget", confirmedBy: "phone" });
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
    const { state: _a, ...foreignBody } = (await foreign.json()) as Record<string, unknown>;
    const { state: _b, ...deletedBody } = (await deleted.json()) as Record<string, unknown>;
    expect(foreignBody).toEqual(deletedBody);
    expect(foreignBody).toEqual({ status: "rejected", reason: "The task no longer exists" });
    const theirRow = await t.run(async (ctx) => await ctx.db.get(theirs.instanceId));
    expect(theirRow!.state).toBe("due");
    expect(theirRow!.confirmedAt).toBeUndefined();
    const theirAudits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter(
        (a) => a.householdId === theirs.householdId && a.actorKind === "senior_device",
      ),
    );
    expect(theirAudits).toEqual([]);
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
      { ...good, instanceId: "abc" },
      { ...good, instanceId: f.householdId },
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
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
    }
    const row = await t.run(async (ctx) => await ctx.db.get(f.instanceId));
    expect(row!.state).toBe("upcoming");
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
