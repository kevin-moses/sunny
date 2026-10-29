// convex/phone.test.ts
// Purpose: Tests for phone verification (phone.ts, exported as households.setMyPhone and
// households.confirmMyPhone) with convex-test and a stubbed global fetch (Twilio is never
// called). The texted code is read from the scheduled
// internal.sms.send call, so no SMS is sent. Covers: number normalization on the way in,
// pending state, the scheduled message, hashing at rest, the correct code, a wrong code and
// attempts left, the fifth wrong guess locking, expiry at 10 minutes, a resend replacing the
// code and resetting attempts, the send rate limits (per caregiver and per number), member
// only access (outsiders, devices, viewers allowed), texting not configured, the verified
// phone and phoneVerified in listMembers (and hidden numbers for a device), and the lookup
// index by phone.
//
// Last modified: 2026-10-29

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CODE_TTL_MS, MAX_CODE_ATTEMPTS, hashCode } from "./phone";
import { createFamilyHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T15:00:00Z"));
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001111");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ sid: "SM1" }, { status: 201 })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * purpose: A family household (Pat primary, Max member, Val viewer, one device) with the rate
 *          limiter component registered.
 * @return: (Promise<Fixture>) Harness and household.
 */
async function setup(): Promise<Fixture> {
  const t = makeBackend();
  rateLimiterTest.register(t);
  return { t, householdId: await createFamilyHousehold(t) };
}

/**
 * purpose: The texts sent or queued through internal.sms.send, oldest first.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<{to, body}[]>) Destination and body of each pending send.
 */
async function queuedTexts(t: TestConvex): Promise<{ to: string; body: string }[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect();
    return rows
      .filter((r) => r.name === "sms:send")
      .map((r) => r.args[0] as { to: string; body: string });
  });
}

/**
 * purpose: The code in the most recent queued text.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<string>) Six digits.
 */
async function lastCode(t: TestConvex): Promise<string> {
  const texts = await queuedTexts(t);
  return /Sunny code: (\d{6})\./.exec(texts.at(-1)!.body)![1]!;
}

describe("setMyPhone", () => {
  test("normalizes a US number, stores it as pending and queues one text", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    const result = await pat.mutation(api.households.setMyPhone, {
      householdId,
      phone: "(555) 123-4567",
    });
    expect(result.phone).toBe("+15551234567");
    expect(Math.abs(result.expiresAt - (Date.now() + CODE_TTL_MS))).toBeLessThan(1000);
    const members = await pat.query(api.households.listMembers, { householdId });
    const me = members.find((m) => m.userId === "pat")!;
    expect(me.pendingPhone).toBe("+15551234567");
    expect(me.phone).toBeUndefined();
    expect(me.phoneVerified).toBe(false);
    const texts = await queuedTexts(t);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.to).toBe("+15551234567");
    expect(texts[0]!.body).toMatch(/^Sunny code: \d{6}\. .*Reply STOP to opt out\.$/);
  });

  test("accepts an international E.164 number", async () => {
    const { t, householdId } = await setup();
    const result = await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.setMyPhone, { householdId, phone: "+44 20 7183 8750" });
    expect(result.phone).toBe("+442071838750");
  });

  test.each(["15551234567", "12345", "abc", "", "+0123456789"])(
    "rejects %j as not a usable number",
    async (phone) => {
      const { t, householdId } = await setup();
      await expect(
        t.withIdentity({ subject: "pat" }).mutation(api.households.setMyPhone, {
          householdId,
          phone,
        }),
      ).rejects.toThrow(/invalid/);
      expect(await queuedTexts(t)).toHaveLength(0);
    },
  );

  test("stores only a hash of the code", async () => {
    const { t, householdId } = await setup();
    await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    const code = await lastCode(t);
    const rows = await t.run(async (ctx) => await ctx.db.query("phoneVerifications").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(rows[0]!.codeHash).toBe(await hashCode("pat", "+15551234567", code));
  });

  test("a viewer may add a number", async () => {
    const { t, householdId } = await setup();
    await t
      .withIdentity({ subject: "val" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5551230000" });
    expect(await queuedTexts(t)).toHaveLength(1);
  });

  test("a non-member is forbidden", async () => {
    const { t, householdId } = await setup();
    await expect(
      t
        .withIdentity({ subject: "stranger" })
        .mutation(api.households.setMyPhone, { householdId, phone: "5551234567" }),
    ).rejects.toThrow(/forbidden/);
  });

  test("a paired device is forbidden", async () => {
    const { t, householdId } = await setup();
    await expect(
      t
        .withIdentity({ subject: "phone", sunny_kind: "device" })
        .mutation(api.households.setMyPhone, { householdId, phone: "5551234567" }),
    ).rejects.toThrow(/forbidden/);
  });

  test("signed out is rejected", async () => {
    const { t, householdId } = await setup();
    await expect(
      t.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" }),
    ).rejects.toThrow(/unauthenticated/);
  });

  test("fails with a clear error when texting is not configured", async () => {
    const { t, householdId } = await setup();
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    await expect(
      t
        .withIdentity({ subject: "pat" })
        .mutation(api.households.setMyPhone, { householdId, phone: "5551234567" }),
    ).rejects.toThrow(/not available yet/);
  });

  test("a resend replaces the earlier code (only the new one works)", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    const first = await lastCode(t);
    let second = first;
    while (second === first) {
      vi.advanceTimersByTime(61_000);
      await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
      second = await lastCode(t);
    }
    const rows = await t.run(async (ctx) => await ctx.db.query("phoneVerifications").collect());
    expect(rows).toHaveLength(1);
    expect(
      await pat.mutation(api.households.confirmMyPhone, { householdId, code: first }),
    ).toMatchObject({ status: "wrong_code" });
    expect(
      await pat.mutation(api.households.confirmMyPhone, { householdId, code: second }),
    ).toEqual({ status: "verified", phone: "+15551234567" });
  });

  test("rate limits sends per caregiver: a burst of three, then wait", async () => {
    const { t, householdId } = await setup();
    const max = t.withIdentity({ subject: "max" });
    for (const phone of ["5551230001", "5551230002", "5551230003"]) {
      await max.mutation(api.households.setMyPhone, { householdId, phone });
    }
    await expect(
      max.mutation(api.households.setMyPhone, { householdId, phone: "5551230004" }),
    ).rejects.toThrow(/limit/);
    vi.advanceTimersByTime(61_000);
    await max.mutation(api.households.setMyPhone, { householdId, phone: "5551230005" });
    expect(await queuedTexts(t)).toHaveLength(4);
  });

  test("rate limits sends per number across caregivers: three an hour", async () => {
    const { t, householdId } = await setup();
    for (const user of ["pat", "max", "val"]) {
      await t
        .withIdentity({ subject: user })
        .mutation(api.households.setMyPhone, { householdId, phone: "5559990000" });
    }
    // The number is spent; another caregiver (or the same one later) cannot text it again.
    vi.advanceTimersByTime(5 * 60_000);
    await expect(
      t
        .withIdentity({ subject: "pat" })
        .mutation(api.households.setMyPhone, { householdId, phone: "5559990000" }),
    ).rejects.toThrow(/limit/);
    vi.advanceTimersByTime(61 * 60_000);
    await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5559990000" });
  });
});

describe("confirmMyPhone", () => {
  /** Start verification for Pat and return the fixture and the code. */
  async function started(): Promise<Fixture & { code: string }> {
    const f = await setup();
    await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.setMyPhone, { householdId: f.householdId, phone: "5551234567" });
    return { ...f, code: await lastCode(f.t) };
  }

  test("the right code verifies the number", async () => {
    const { t, householdId, code } = await started();
    const pat = t.withIdentity({ subject: "pat" });
    expect(await pat.mutation(api.households.confirmMyPhone, { householdId, code })).toEqual({
      status: "verified",
      phone: "+15551234567",
    });
    const me = (await pat.query(api.households.listMembers, { householdId })).find(
      (m) => m.userId === "pat",
    )!;
    expect(me.phone).toBe("+15551234567");
    expect(me.phoneVerified).toBe(true);
    expect(me.phoneVerifiedAt).toBeGreaterThanOrEqual(Date.parse("2026-10-29T15:00:00Z"));
    expect(me.pendingPhone).toBeUndefined();
    const rows = await t.run(async (ctx) => await ctx.db.query("phoneVerifications").collect());
    expect(rows).toHaveLength(0);
  });

  test("the code may be typed with surrounding spaces", async () => {
    const { t, householdId, code } = await started();
    const result = await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.confirmMyPhone, { householdId, code: ` ${code} ` });
    expect(result.status).toBe("verified");
  });

  test("a wrong code reports attempts left and verifies nothing", async () => {
    const { t, householdId, code } = await started();
    const pat = t.withIdentity({ subject: "pat" });
    const wrong = code === "000000" ? "000001" : "000000";
    expect(await pat.mutation(api.households.confirmMyPhone, { householdId, code: wrong })).toEqual(
      { status: "wrong_code", attemptsLeft: MAX_CODE_ATTEMPTS - 1 },
    );
    const me = (await pat.query(api.households.listMembers, { householdId })).find(
      (m) => m.userId === "pat",
    )!;
    expect(me.phoneVerified).toBe(false);
  });

  test("the fifth wrong guess locks, and then even the right code is refused", async () => {
    const { t, householdId, code } = await started();
    const pat = t.withIdentity({ subject: "pat" });
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      expect(
        await pat.mutation(api.households.confirmMyPhone, { householdId, code: wrong }),
      ).toEqual({ status: "wrong_code", attemptsLeft: MAX_CODE_ATTEMPTS - i });
    }
    expect(await pat.mutation(api.households.confirmMyPhone, { householdId, code: wrong })).toEqual(
      { status: "locked" },
    );
    expect(await pat.mutation(api.households.confirmMyPhone, { householdId, code })).toEqual({
      status: "locked",
    });
  });

  test("a resend after locking gives a fresh set of attempts", async () => {
    const { t, householdId, code } = await started();
    const pat = t.withIdentity({ subject: "pat" });
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      await pat.mutation(api.households.confirmMyPhone, { householdId, code: wrong });
    }
    vi.advanceTimersByTime(61_000);
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    const fresh = await lastCode(t);
    expect(
      await pat.mutation(api.households.confirmMyPhone, { householdId, code: fresh }),
    ).toMatchObject({ status: "verified" });
  });

  test("an expired code is refused and cleared", async () => {
    const { t, householdId, code } = await started();
    const pat = t.withIdentity({ subject: "pat" });
    vi.advanceTimersByTime(CODE_TTL_MS + 1000);
    expect(await pat.mutation(api.households.confirmMyPhone, { householdId, code })).toEqual({
      status: "expired",
    });
    expect(await pat.mutation(api.households.confirmMyPhone, { householdId, code })).toEqual({
      status: "none",
    });
    const me = (await pat.query(api.households.listMembers, { householdId })).find(
      (m) => m.userId === "pat",
    )!;
    expect(me.pendingPhone).toBeUndefined();
  });

  test("a code just inside the expiry still works", async () => {
    const { t, householdId, code } = await started();
    vi.advanceTimersByTime(CODE_TTL_MS - 1000);
    const result = await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.confirmMyPhone, { householdId, code });
    expect(result.status).toBe("verified");
  });

  test("with nothing pending the status is none", async () => {
    const { t, householdId } = await setup();
    expect(
      await t
        .withIdentity({ subject: "max" })
        .mutation(api.households.confirmMyPhone, { householdId, code: "123456" }),
    ).toEqual({ status: "none" });
  });

  test("another member cannot use Pat's code", async () => {
    const { t, householdId, code } = await started();
    expect(
      await t
        .withIdentity({ subject: "max" })
        .mutation(api.households.confirmMyPhone, { householdId, code }),
    ).toEqual({ status: "none" });
  });

  test("a non-member is forbidden", async () => {
    const { t, householdId, code } = await started();
    await expect(
      t
        .withIdentity({ subject: "stranger" })
        .mutation(api.households.confirmMyPhone, { householdId, code }),
    ).rejects.toThrow(/forbidden/);
  });

  test("a new number replaces the verified one only after it is confirmed", async () => {
    const { t, householdId, code } = await started();
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.confirmMyPhone, { householdId, code });
    vi.advanceTimersByTime(61_000);
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5557778888" });
    const me = (await pat.query(api.households.listMembers, { householdId })).find(
      (m) => m.userId === "pat",
    )!;
    expect(me.phone).toBe("+15551234567");
    expect(me.pendingPhone).toBe("+15557778888");
    expect(me.phoneVerified).toBe(true);
    await pat.mutation(api.households.confirmMyPhone, { householdId, code: await lastCode(t) });
    const after = (await pat.query(api.households.listMembers, { householdId })).find(
      (m) => m.userId === "pat",
    )!;
    expect(after.phone).toBe("+15557778888");
  });
});

describe("listMembers and the phone index", () => {
  test("a device sees phoneVerified but no numbers", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await pat.mutation(api.households.confirmMyPhone, {
      householdId,
      code: await lastCode(t),
    });
    const members = await t
      .withIdentity({ subject: "phone" })
      .query(api.households.listMembers, { householdId });
    const me = members.find((m) => m.userId === "pat")!;
    expect(me.phoneVerified).toBe(true);
    expect(me).not.toHaveProperty("phone");
    expect(me).not.toHaveProperty("pendingPhone");
  });

  test("a legacy phone without a verification is not phoneVerified", async () => {
    const { t, householdId } = await setup();
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("householdMembers")
        .withIndex("by_household_user", (q) => q.eq("householdId", householdId).eq("userId", "max"))
        .unique();
      await ctx.db.patch(m!._id, { phone: "+15550009999" });
    });
    const members = await t
      .withIdentity({ subject: "pat" })
      .query(api.households.listMembers, { householdId });
    expect(members.find((m) => m.userId === "max")!.phoneVerified).toBe(false);
  });

  test("members can be looked up by verified phone", async () => {
    const { t, householdId } = await setup();
    const max = t.withIdentity({ subject: "max" });
    await max.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await max.mutation(api.households.confirmMyPhone, { householdId, code: await lastCode(t) });
    const found = await t.run(async (ctx) => {
      return await ctx.db
        .query("householdMembers")
        .withIndex("by_phone", (q) => q.eq("phone", "+15551234567"))
        .collect();
    });
    expect(found.map((m) => m.userId)).toEqual(["max"]);
    expect(found[0]!.phoneVerifiedAt).toBeDefined();
  });
});
