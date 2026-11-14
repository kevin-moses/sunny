// convex/deviceApi.test.ts
// Purpose: Tests for the device API (deviceApi.ts) and the caregiver's token revoke
// (households.revokeDeviceToken) with convex-test and a frozen clock (Date only, so the rate
// limiter's buckets never refill mid-test).
// Token: issue (format, only the hash stored, audited without the token), rotation (the old token
// gets 401), at most 10 issues an hour, removal revokes at once, a caregiver revoke (editor only;
// a viewer, a device and another household's editor refused; the device stays paired), the hash
// in no listDevices or response and the token in no log or audit row, a caregiver or signed-out
// caller cannot issue.
// Authentication: one identical 401 for missing, malformed and unknown tokens; the failed-attempt
// buckets (global and per-IP, the per-IP one untouched while the global one is empty) turn 401
// into 429 while a valid token keeps working; the per-device bucket; no-store on 401, 400, 429
// and an unexpected 500 on every route.
// State: ETag and 304 (weak, list and "*" forms), the Clerk query and the HTTP route return the
// same object, the query refuses caregivers and signed-out callers, cue prompt instants match
// the real scheduler's ticks, tomorrow's instance inside the 24 hours.
// Confirm: success (device's via, confirmedBy and audit actor; fresh state and ETag), a press
// that stands when the state cannot be read afterwards (state null), missed and anytime
// instances by id, replayed presses (late sync at the press time, too early, too late), a
// deleted instance (rejected, audited), another household's instance (same answer as a deleted
// one, left alone, audited without its id), 400 for bad bodies, ids and press ages (each
// audited, nothing raw stored), the 20-an-hour cap on refusal rows (the core's refusals, such as
// a press before the early window or on a deleted task, count and stop being written too), and a
// body over 4096 characters. A device-API confirm is a device confirm: its audit rows say
// transport device_api (the app's say app), a caregiver's reopen stamps it so an older queued
// press is refused, the phone app's Undo takes it back, and there is no /device/undo route.
// Info: stored and trimmed, 204, validation, no other field writable. A device removed between
// the gate and the effect: every by-token function finds nothing and writes nothing.
// lastSeenAt: written at most every 5 minutes, not for a failed authentication.
//
// Last modified: 2026-11-14

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
 * purpose: Every audit row, oldest first.
 * @param t: (TestConvex) Harness.
 * @return: The rows.
 */
async function audits(t: TestConvex) {
  return await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
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
    // Refused presses and failures are audited or logged; none of it carries the token either.
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
    // 30 s refill the global bucket by 30; had IP A's bucket been spent above, it would hold
    // only 5 and the sixth request below would be 429.
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
    await force(f, { state: "due" });
    const token = await issue(t);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // With the household row gone the press still applies but the state load throws.
    await t.run(async (ctx) => await ctx.db.delete(f.householdId));
    const res = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 0,
      via: "button",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "confirmed", reason: null, state: null });
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
      via: "button",
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
    const { state: _a, ...foreignBody } = (await foreign.json()) as Record<string, unknown>;
    const { state: _b, ...deletedBody } = (await deleted.json()) as Record<string, unknown>;
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
    // Every refused press is audited, with only the safe parts of what was sent.
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
    /**
     * purpose: How many press_not_applied rows exist.
     * @return: (Promise<number>) The count.
     */
    const refusedRows = async (): Promise<number> =>
      (await audits(t)).filter((a) => a.action === "press_not_applied").length;
    for (let i = 0; i < 20; i++) expect((await postConfirm(t, token, malformed)).status).toBe(400);
    expect(await refusedRows()).toBe(20);
    expect((await postConfirm(t, token, malformed)).status).toBe(400);
    // A refusal by the core (pressed before the early window) is answered but not written either.
    const early = await postConfirm(t, token, {
      instanceId: f.instanceId,
      pressedAgoMs: 10 * MIN,
      via: "button",
    });
    expect(await early.json()).toMatchObject({
      status: "rejected",
      reason: "This task was not due yet when it was pressed",
    });
    expect(await refusedRows()).toBe(20);
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
    /**
     * purpose: How many press_not_applied rows exist.
     * @return: (Promise<number>) The count.
     */
    const refusedRows = async (): Promise<number> =>
      (await audits(t)).filter((a) => a.action === "press_not_applied").length;
    expect(await refusedRows()).toBe(20);
    expect(
      (await postConfirm(t, token, { instanceId: "abc", pressedAgoMs: 0, via: "button" })).status,
    ).toBe(400);
    expect(await refusedRows()).toBe(20);
  });
});

describe("a confirm through the device API is a device confirm", () => {
  test("every confirm and refusal records how it arrived (transport)", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t, "display");
    await postConfirm(t, token, { instanceId: f.instanceId, pressedAgoMs: 0, via: "button" });
    await postConfirm(t, token, { instanceId: "abc", pressedAgoMs: 0, via: "button" });
    const second = await household(t, "z_");
    await force(second, { state: "due" });
    await t.withIdentity({ subject: "z_phone" }).mutation(api.instances.confirmPressedTask, {
      instanceId: second.instanceId,
      via: "phone_app",
      pressedAgoMs: 0,
    });
    const rows = await audits(t);
    /**
     * purpose: The transport of a household's audit row with an action.
     * @param householdId: (Id<"households">) The household.
     * @param action: (string) The action.
     * @return: (unknown) detail.transport.
     */
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

  test("the phone app's Undo takes back a press the same device made through the API", async () => {
    const t = makeBackend();
    const f = await household(t);
    await force(f, { state: "due" });
    const token = await issue(t, "phone");
    setNow(local("08:05"));
    await postConfirm(t, token, { instanceId: f.instanceId, pressedAgoMs: 0, via: "widget" });
    setNow(local("08:05") + 20_000);
    const undone = await t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.undoPressedTask, { instanceId: f.instanceId });
    expect(undone.status).toBe("undone");
    expect((await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.state).toBe("due");
  });

  test("the device API offers no undo route", async () => {
    const t = makeBackend();
    await household(t);
    const token = await issue(t, "display");
    const res = await call(t, "POST", "/device/undo", { token, body: {} });
    expect(res.status).toBe(404);
  });
});

describe("revokeDeviceToken", () => {
  test("an editor revokes the token; the device stays paired and can issue a new one", async () => {
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
    expect((await audits(t)).find((a) => a.action === "revoke_device_token")).toMatchObject({
      actorKind: "caregiver",
      actorUserId: "pat",
      entityId: f.phoneId,
      detail: { hadToken: true },
    });
    expect((await getState(t, await issue(t))).status).toBe(200);
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

describe("a device removed between the gate and the effect", () => {
  test("every by-token function finds nothing and writes nothing", async () => {
    const t = makeBackend();
    const f = await household(t);
    const tokenHash = await hashDeviceToken(UNKNOWN_TOKEN);
    expect(await t.mutation(internal.deviceApi.admit, { tokenHash })).toEqual({ kind: "unknown" });
    expect(await t.query(internal.deviceApi.stateByToken, { tokenHash })).toBeNull();
    expect(
      await t.mutation(internal.deviceApi.confirmByToken, {
        tokenHash,
        instanceId: f.instanceId,
        via: "button",
        pressedAgoMs: 0,
      }),
    ).toEqual({ kind: "unauthorized" });
    expect(
      await t.mutation(internal.deviceApi.updateInfoByToken, { tokenHash, firmware: "1.0" }),
    ).toBe(false);
    await t.mutation(internal.deviceApi.refusePressByToken, {
      tokenHash,
      reason: "The press could not be read",
      pressedAgoMs: null,
      via: null,
    });
    expect((await t.run(async (ctx) => await ctx.db.get(f.instanceId)))!.state).toBe("upcoming");
    expect((await audits(t)).some((a) => a.action === "press_not_applied")).toBe(false);
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
      await postConfirm(t, token, {}),
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
