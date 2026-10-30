// convex/pairing.test.ts
// Purpose: Tests for the /pair HTTP action (pairing.ts) with convex-test and a stubbed global
// fetch standing in for Clerk's Backend API: the success path (ticket, device row, Clerk
// calls and fields incl. the random device username and the taken-username retry), codes that cannot be redeemed (unknown, used, expired, caregiver) which
// give 404 without ever calling Clerk, cleanup when pairDevice fails (Clerk user deleted),
// rollback when the sign-in token fails (including a rollback that itself throws), Clerk
// network errors (502, nothing left behind), request validation, the overall bucket and the
// failed-attempt buckets (global and per-IP, 429 with Retry-After), the lost-response retry
// with pairingNonce (same Clerk user, username patched on when missing, wrong nonce and late retry give 404), no-store
// caching, a missing CLERK_SECRET_KEY (500), clientIp header parsing, and the best-effort
// deleteClerkUser action. No real network calls are made.
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
  /** Reject the create-user fetch as a network error. */
  createUserNetworkError?: boolean;
  /** Statuses for successive create-user calls (422 bodies carry form_identifier_exists). */
  createUserStatuses?: number[];
  /** The username the existing user has on GET /users/{id}; unset means none. */
  existingUsername?: string;
  /** Status for PATCH /users/{id}. */
  patchStatus?: number;
  /** Runs when a sign-in token is requested, before the reply. */
  onSignInToken?: () => Promise<void>;
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
        if (behavior.createUserNetworkError) throw new TypeError("fetch failed");
        const status = behavior.createUserStatuses?.shift() ?? behavior.createUserStatus ?? 200;
        if (status === 422) return reply(422, { errors: [{ code: "form_identifier_exists" }] });
        return reply(status, { id: behavior.userId });
      }
      if (init?.method === "GET" && path.startsWith("/users/")) {
        return reply(200, { id: behavior.userId, username: behavior.existingUsername ?? null });
      }
      if (init?.method === "PATCH" && path.startsWith("/users/")) {
        return reply(behavior.patchStatus ?? 200, { id: behavior.userId });
      }
      if (init?.method === "POST" && path === "/sign_in_tokens") {
        await behavior.onSignInToken?.();
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
    expect(calls[0]!.body!.username).toMatch(/^device_[0-9a-f]{32}$/);
    expect(calls[1]!.body).toEqual({ user_id: "user_clerk_1", expires_in_seconds: 600 });
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

  test("a taken username is retried once with a different username", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    behavior.createUserStatuses = [422, 200];

    const res = await postPair(t, { code });

    expect(res.status).toBe(200);
    const creates = calls.filter((c) => c.method === "POST" && c.path === "/users");
    expect(creates).toHaveLength(2);
    expect(creates[1]!.body!.username).toMatch(/^device_[0-9a-f]{32}$/);
    expect(creates[1]!.body!.username).not.toBe(creates[0]!.body!.username);
  });

  test("two taken usernames in a row give 502 and pair nothing", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    behavior.createUserStatuses = [422, 422];
    const res = await postPair(t, { code });
    expect(res.status).toBe(502);
    expect(calls.filter((c) => c.path === "/users")).toHaveLength(2);
    expect(await devices(t)).toHaveLength(0);
  });

  test("a Clerk create failure gives 502 and pairs nothing", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    behavior.createUserStatus = 400;
    const res = await postPair(t, { code });
    expect(res.status).toBe(502);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /users"]);
    expect(await devices(t)).toHaveLength(0);
  });

  test("a rollback that throws is logged and the Clerk user is still deleted", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    behavior.signInTokenStatus = 500;
    // Remove the device row mid-flight so rollbackPairing's delete fails.
    behavior.onSignInToken = async () => {
      await t.run(async (ctx) => {
        const [device] = await ctx.db.query("devices").collect();
        await ctx.db.delete(device!._id);
      });
    };

    const res = await postPair(t, { code });

    expect(res.status).toBe(502);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /users/user_clerk_1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("rollback failed"));
  });

  test("a Clerk network error gives 502, leaves no device and keeps the code redeemable", async () => {
    const t = makeBackend();
    const { householdId, code } = await householdWithCode(t);
    behavior.createUserNetworkError = true;

    const res = await postPair(t, { code });

    expect(res.status).toBe(502);
    expect(await devices(t)).toHaveLength(0);
    const open = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listJoinCodes, { householdId });
    expect(open.map((c) => c.code)).toEqual([code]);
    behavior.createUserNetworkError = false;
    expect((await postPair(t, { code })).status).toBe(200);
  });

  test("Clerk calls carry an abort signal for the timeout", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code });
    const fetchMock = vi.mocked(fetch);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
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
  test("30 failed code checks a minute exhaust the failed bucket, then 429 with Retry-After", async () => {
    const t = makeBackend();
    for (let i = 0; i < 30; i++) {
      expect((await postPair(t, { code: "NOPE1234" })).status).toBe(404);
    }
    const res = await postPair(t, { code: "NOPE1234" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  test("junk bodies do not spend the failed bucket, so valid pairing still works", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    for (let i = 0; i < 40; i++) expect((await postPair(t, "{nope")).status).toBe(400);
    expect((await postPair(t, { code })).status).toBe(200);
  });

  test("the overall bucket allows 300 requests a minute, then 429", async () => {
    const t = makeBackend();
    for (let i = 0; i < 300; i++) expect((await postPair(t, "{nope")).status).toBe(400);
    expect((await postPair(t, "{nope")).status).toBe(429);
  });

  test("the per-IP failed bucket limits one address without blocking another", async () => {
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

  test("an over-long forwarded address is accepted and shares one truncated key", async () => {
    const t = makeBackend();
    const long = "a".repeat(5000);
    for (let i = 0; i < 10; i++) {
      expect((await postPair(t, { code: "NOPE1234" }, { "x-forwarded-for": long })).status).toBe(
        404,
      );
    }
    expect((await postPair(t, { code: "NOPE1234" }, { "x-forwarded-for": long })).status).toBe(429);
  });

  test("an exhausted failed bucket returns 429 before the code is checked", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    for (let i = 0; i < 30; i++) await postPair(t, { code: "NOPE1234" });
    const res = await postPair(t, { code });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
    expect(await devices(t)).toHaveLength(0);
  });
});

describe("POST /pair lost-response retry", () => {
  const NONCE = "nonce-0123456789abcdef";

  test("a retry with the same nonce gets a fresh ticket for the same Clerk user", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    const first = await postPair(t, { code, pairingNonce: NONCE });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, string>;
    calls = [];
    behavior.userId = "user_clerk_2";
    behavior.existingUsername = "device_abc12345";

    const retry = await postPair(t, { code, pairingNonce: NONCE });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstBody);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /users/user_clerk_1",
      "POST /sign_in_tokens",
    ]);
    expect(calls[1]!.body).toMatchObject({ user_id: "user_clerk_1" });
    const rows = await devices(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "user_clerk_1", pairingNonce: NONCE });
  });

  test("a retry patches a username onto a user that has none", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    calls = [];

    const retry = await postPair(t, { code, pairingNonce: NONCE });

    expect(retry.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /users/user_clerk_1",
      "PATCH /users/user_clerk_1",
      "POST /sign_in_tokens",
    ]);
    expect(calls[1]!.body!.username).toMatch(/^device_[0-9a-f]{32}$/);
  });

  test("a retry does not patch a user that already has a username", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    calls = [];
    behavior.existingUsername = "device_abc12345";

    expect((await postPair(t, { code, pairingNonce: NONCE })).status).toBe(200);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /users/user_clerk_1",
      "POST /sign_in_tokens",
    ]);
  });

  test("a failed username patch on retry gives 502 and keeps the device", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    behavior.patchStatus = 500;
    expect((await postPair(t, { code, pairingNonce: NONCE })).status).toBe(502);
    expect(await devices(t)).toHaveLength(1);
  });

  test("a different nonce gets 404", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    calls = [];
    const res = await postPair(t, { code, pairingNonce: "other-nonce-0123456789" });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("no nonce on the retry gets 404", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    expect((await postPair(t, { code })).status).toBe(404);
  });

  test("a pairing without a nonce cannot be retried", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code });
    expect((await postPair(t, { code, pairingNonce: NONCE })).status).toBe(404);
  });

  test("a retry after 10 minutes gets 404", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    await t.run(async (ctx) => {
      const [device] = await ctx.db.query("devices").collect();
      await ctx.db.patch(device!._id, { pairedAt: Date.now() - 10 * 60 * 1000 - 1000 });
    });
    expect((await postPair(t, { code, pairingNonce: NONCE })).status).toBe(404);
  });

  test("a retry after the device was removed gets 404", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    await t.run(async (ctx) => {
      const [device] = await ctx.db.query("devices").collect();
      await ctx.db.delete(device!._id);
    });
    expect((await postPair(t, { code, pairingNonce: NONCE })).status).toBe(404);
  });

  test("a Clerk failure while re-issuing the ticket gives 502 and keeps the device", async () => {
    const t = makeBackend();
    const { code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    behavior.signInTokenStatus = 500;
    expect((await postPair(t, { code, pairingNonce: NONCE })).status).toBe(502);
    expect(await devices(t)).toHaveLength(1);
  });

  test.each([["short"], ["x".repeat(129)], [12]])("a bad nonce %s gives 400", async (nonce) => {
    const t = makeBackend();
    const res = await postPair(t, { code: "ABCD2345", pairingNonce: nonce });
    expect(res.status).toBe(400);
  });

  test("listDevices never returns the nonce", async () => {
    const t = makeBackend();
    const { householdId, code } = await householdWithCode(t);
    await postPair(t, { code, pairingNonce: NONCE });
    const listed = await t
      .withIdentity({ subject: "user_a" })
      .query(api.households.listDevices, { householdId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("pairingNonce");
    expect(listed[0]).toHaveProperty("pairedAt");
  });
});

describe("POST /pair response headers", () => {
  test.each([
    ["success", async (t: TestConvex) => postPair(t, { code: (await householdWithCode(t)).code })],
    ["404", async (t: TestConvex) => postPair(t, { code: "NOPE1234" })],
    ["400", async (t: TestConvex) => postPair(t, "{nope")],
  ])("%s carries Cache-Control: no-store", async (_label, run) => {
    const t = makeBackend();
    expect((await run(t)).headers.get("Cache-Control")).toBe("no-store");
  });

  test("429 carries Cache-Control: no-store", async () => {
    const t = makeBackend();
    for (let i = 0; i < 30; i++) await postPair(t, { code: "NOPE1234" });
    const res = await postPair(t, { code: "NOPE1234" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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
