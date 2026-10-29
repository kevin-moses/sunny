// convex/pairing.test.ts
// Purpose: Tests for the /pair HTTP action (pairing.ts) with convex-test and a stubbed global
// fetch standing in for Clerk's Backend API: the success path (ticket, device row, Clerk
// calls and fields), codes that cannot be redeemed (unknown, used, expired, caregiver) which
// give 404 without ever calling Clerk, cleanup when pairDevice fails (Clerk user deleted),
// rollback when the sign-in token fails, request validation, the global and per-IP rate
// limits (429 with Retry-After), a missing CLERK_SECRET_KEY (500), clientIp header parsing,
// and the best-effort deleteClerkUser action. No real network calls are made.
//
// Last modified: 2026-10-29

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { clientIp } from "./pairing";
import schema from "./schema";

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** One recorded request to the fake Clerk API. */
interface ClerkCall {
  method: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

/** What the fake Clerk API does; each field is a status override, 200 when unset. */
interface ClerkBehavior {
  userId: string;
  createUserStatus?: number;
  signInTokenStatus?: number;
  deleteStatus?: number;
}

let calls: ClerkCall[] = [];
let behavior: ClerkBehavior = { userId: "user_clerk_1" };
const savedEnv: Record<string, string | undefined> = {};

/**
 * purpose: Install a fake global fetch that records Clerk calls and answers per `behavior`.
 * @return: (void)
 */
function stubClerk(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/v1/, "");
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? "GET",
        path,
        authorization: headers.get("Authorization"),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      const reply = (status: number, json: unknown) => Response.json(json, { status });
      if (init?.method === "POST" && path === "/users") {
        return reply(behavior.createUserStatus ?? 200, { id: behavior.userId });
      }
      if (init?.method === "POST" && path === "/sign_in_tokens") {
        return reply(behavior.signInTokenStatus ?? 200, { token: "ticket_abc" });
      }
      if (init?.method === "DELETE") return reply(behavior.deleteStatus ?? 200, { deleted: true });
      return reply(500, {});
    }),
  );
}

beforeEach(() => {
  calls = [];
  behavior = { userId: "user_clerk_1" };
  savedEnv.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
  process.env.CLERK_SECRET_KEY = "sk_test_fake";
  stubClerk();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedEnv.CLERK_SECRET_KEY === undefined) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = savedEnv.CLERK_SECRET_KEY;
});

/**
 * purpose: A fresh in-memory backend with the rate limiter component registered.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
}

/** The convex-test harness type. */
type TestConvex = ReturnType<typeof makeBackend>;

/**
 * purpose: Create a household owned by user_a and a join code for it.
 * @param t: (TestConvex) Harness.
 * @param grants: (string) What the code grants.
 * @return: (Promise<{householdId, code}>) The household and the code.
 */
async function householdWithCode(
  t: TestConvex,
  grants: "senior_phone" | "home_display" | "caregiver_member" = "senior_phone",
): Promise<{ householdId: Id<"households">; code: string }> {
  const asA = t.withIdentity({ subject: "user_a" });
  const householdId = await asA.mutation(api.households.create, {
    seniorPreferredName: "Margaret",
    timezone: "America/New_York",
    caregiverDisplayName: "Anna",
  });
  const { code } = await asA.mutation(api.households.createJoinCode, { householdId, grants });
  return { householdId, code };
}

/**
 * purpose: POST to /pair.
 * @param t: (TestConvex) Harness.
 * @param body: (unknown) JSON body, or a raw string sent as is.
 * @param headers: (Record<string, string>, optional) Extra request headers.
 * @return: (Promise<Response>) The response.
 */
async function postPair(
  t: TestConvex,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await t.fetch("/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * purpose: Device rows in the backend.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<Array<{userId, name}>>) Rows.
 */
async function devices(t: TestConvex) {
  return await t.run(async (ctx) => await ctx.db.query("devices").collect());
}

describe("POST /pair success", () => {
  test("returns a ticket, pairs the device and uses the Clerk fields", async () => {
    const t = makeBackend();
    const { householdId, code } = await householdWithCode(t);

    const res = await postPair(t, { code: ` ${code.toLowerCase()} `, name: "  Kitchen  " });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, string>;
    expect(json.ticket).toBe("ticket_abc");
    expect(json.householdId).toBe(householdId);
    expect(json.kind).toBe("senior_phone");
    const rows = await devices(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "user_clerk_1", name: "Kitchen", householdId });
    expect(json.deviceId).toBe(rows[0]!._id);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /users",
      "POST /sign_in_tokens",
    ]);
    expect(calls[0]!.authorization).toBe("Bearer sk_test_fake");
    expect(calls[0]!.body).toMatchObject({
      public_metadata: { sunny_kind: "device" },
      skip_password_requirement: true,
    });
    expect(calls[0]!.body).not.toHaveProperty("email_address");
    expect(calls[1]!.body).toEqual({ user_id: "user_clerk_1", expires_in_seconds: 600 });
  });

  test("a home display code pairs a home_display device", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t, "home_display");
    const res = await postPair(t, { code });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("home_display");
  });

  test("the code can be used only once", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    expect((await postPair(t, { code })).status).toBe(200);
    behavior.userId = "user_clerk_2";
    expect((await postPair(t, { code })).status).toBe(404);
    expect(await devices(t)).toHaveLength(1);
  });
});

describe("POST /pair codes that cannot be redeemed", () => {
  const notFound = { error: { code: "not_found", message: "This code is invalid or has expired" } };

  test("unknown code gives 404 and never calls Clerk", async () => {
    const t = makeBackend();
    const res = await postPair(t, { code: "NOPE1234" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFound);
    expect(calls).toHaveLength(0);
  });

  test("a caregiver code gives the same 404 and never calls Clerk", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t, "caregiver_member");
    const res = await postPair(t, { code });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFound);
    expect(calls).toHaveLength(0);
  });

  test("an expired code gives 404 and never calls Clerk", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("joinCodes")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    const res = await postPair(t, { code });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("a used code gives 404 and never calls Clerk", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await t.mutation(internal.households.pairDevice, { code, userId: "someone" });
    const res = await postPair(t, { code });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /pair failures after the Clerk user exists", () => {
  test("a pairDevice failure deletes the Clerk user and leaves the code redeemable", async () => {
    const t = makeBackend();
    const { householdId, code } = await householdWithCode(t);
    // The Clerk id is already a paired device, so pairDevice refuses it.
    await t.mutation(internal.households.pairDevice, { code, userId: "user_clerk_1" });
    const next = await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.households.createJoinCode, { householdId, grants: "home_display" });

    const res = await postPair(t, { code: next.code });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid", message: "This user is already a paired device" },
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /users",
      "DELETE /users/user_clerk_1",
    ]);
    expect(await devices(t)).toHaveLength(1);
    const open = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listJoinCodes, { householdId });
    expect(open.map((c) => c.code)).toEqual([next.code]);
  });

  test("a sign-in token failure deletes the user and rolls the pairing back", async () => {
    const t = makeBackend();
    const { householdId, code } = await householdWithCode(t);
    behavior.signInTokenStatus = 500;

    const res = await postPair(t, { code });

    expect(res.status).toBe(502);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /users",
      "POST /sign_in_tokens",
      "DELETE /users/user_clerk_1",
    ]);
    expect(await devices(t)).toHaveLength(0);
    const open = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listJoinCodes, { householdId });
    expect(open.map((c) => c.code)).toContain(code);
  });

  test("a Clerk create failure gives 502 and pairs nothing", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    behavior.createUserStatus = 422;
    const res = await postPair(t, { code });
    expect(res.status).toBe(502);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /users"]);
    expect(await devices(t)).toHaveLength(0);
  });

  test("a failing Clerk delete during cleanup does not change the reported error", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    behavior.signInTokenStatus = 500;
    behavior.deleteStatus = 500;
    const res = await postPair(t, { code });
    expect(res.status).toBe(502);
  });
});

describe("POST /pair request validation and configuration", () => {
  test.each([
    ["not JSON", "{nope"],
    ["not an object", "[1]"],
    ["no code", {}],
    ["blank code", { code: "  " }],
    ["numeric code", { code: 12 }],
    ["numeric name", { code: "ABCD2345", name: 5 }],
    ["over-long name", { code: "ABCD2345", name: "x".repeat(101) }],
  ])("%s gives 400", async (_label, body) => {
    const t = makeBackend();
    const res = await postPair(t, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  test("a missing CLERK_SECRET_KEY gives 500 and redeems nothing", async () => {
    const t = makeBackend();
    const { householdId, code } = await householdWithCode(t);
    delete process.env.CLERK_SECRET_KEY;
    const res = await postPair(t, { code });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "not configured",
    );
    expect(calls).toHaveLength(0);
    const open = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listJoinCodes, { householdId });
    expect(open).toHaveLength(1);
  });

  test("only POST is routed", async () => {
    const t = makeBackend();
    const res = await t.fetch("/pair", { method: "GET" });
    expect(res.status).toBe(404);
  });
});

describe("POST /pair rate limits", () => {
  test("the global bucket allows 30 attempts a minute, then 429 with Retry-After", async () => {
    const t = makeBackend();
    for (let i = 0; i < 30; i++) {
      expect((await postPair(t, { code: "NOPE1234" })).status).toBe(404);
    }
    const res = await postPair(t, { code: "NOPE1234" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  test("the per-IP bucket limits one address without blocking another", async () => {
    const t = makeBackend();
    const ipA = { "x-forwarded-for": "203.0.113.1" };
    for (let i = 0; i < 10; i++) {
      expect((await postPair(t, { code: "NOPE1234" }, ipA)).status).toBe(404);
    }
    expect((await postPair(t, { code: "NOPE1234" }, ipA)).status).toBe(429);
    expect(
      (await postPair(t, { code: "NOPE1234" }, { "x-forwarded-for": "203.0.113.2" })).status,
    ).toBe(404);
  });

  test("a limited request never reaches Clerk or the code check", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    for (let i = 0; i < 30; i++) await postPair(t, { code: "NOPE1234" });
    const res = await postPair(t, { code });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
    expect(await devices(t)).toHaveLength(0);
  });
});

describe("clientIp", () => {
  /**
   * purpose: A request carrying the given headers.
   * @param headers: (Record<string, string>) Headers.
   * @return: (Request) The request.
   */
  const req = (headers: Record<string, string>): Request =>
    new Request("https://x.convex.site/pair", { method: "POST", headers });

  test("uses the rightmost x-forwarded-for entry", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 10.0.0.1, 203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
  });

  test("falls back to x-real-ip", () => {
    expect(clientIp(req({ "x-real-ip": " 198.51.100.4 " }))).toBe("198.51.100.4");
  });

  test("is null without a header", () => {
    expect(clientIp(req({}))).toBeNull();
  });
});

describe("deleteClerkUser", () => {
  test("deletes the Clerk user", async () => {
    const t = makeBackend();
    await t.action(internal.pairing.deleteClerkUser, { userId: "user_x" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /users/user_x"]);
    expect(calls[0]!.authorization).toBe("Bearer sk_test_fake");
  });

  test("without a secret it logs and does nothing", async () => {
    const t = makeBackend();
    delete process.env.CLERK_SECRET_KEY;
    await t.action(internal.pairing.deleteClerkUser, { userId: "user_x" });
    expect(calls).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  test("a Clerk failure is logged, not thrown", async () => {
    const t = makeBackend();
    behavior.deleteStatus = 500;
    await expect(
      t.action(internal.pairing.deleteClerkUser, { userId: "user_x" }),
    ).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  test("a user Clerk no longer has (404) counts as deleted", async () => {
    const t = makeBackend();
    behavior.deleteStatus = 404;
    await t.action(internal.pairing.deleteClerkUser, { userId: "user_x" });
    expect(console.error).not.toHaveBeenCalled();
  });
});
