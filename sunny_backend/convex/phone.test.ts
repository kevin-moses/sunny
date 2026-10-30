// convex/phone.test.ts
// Purpose: Tests for phone verification (phone.ts, exported as households.setMyPhone,
// confirmMyPhone and clearMyPhone) with convex-test and a stubbed global fetch (Twilio is never
// called). The code text is made and sent by the scheduled sendCode action, so tests run the
// scheduled functions and read the text from the Twilio request. Covers: number normalization,
// allowed countries (SMS_ALLOWED_COUNTRY_CODES), pending state, only the verification id in the
// scheduled arguments, the code stored as an HMAC, the correct code, wrong codes and the fifth
// locking, expiry, resend, a failed send and a still-sending status, code length cap, the send
// rate limits (burst, per caregiver and number without one caregiver spending another's budget,
// per caregiver and household per day), member-only access, texting not configured,
// clearMyPhone, myPhoneStatus (none, sending, sent, send_failed with safe messages only, expired, members only),
// the hourly sweep, and the verified phone in listMembers and the phone index.
//
// Last modified: 2026-10-29

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { BAD_NUMBER_MESSAGE, CODE_TTL_MS, MAX_CODE_ATTEMPTS, SEND_FAILED_MESSAGE } from "./phone";
import { createFamilyHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
}

/** The stubbed fetch, whose calls are the texts Twilio was asked to send. */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T15:00:00Z"));
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001111");
  vi.stubEnv("CALENDAR_TOKEN_KEY", btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  vi.stubEnv("SMS_ALLOWED_COUNTRY_CODES", "");
  fetchMock = vi.fn(async () => Response.json({ sid: "SM1" }, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
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
 * purpose: Run the scheduled functions (the sendCode actions) and return every text sent to
 *          Twilio so far, oldest first.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<{to, body}[]>) Destination and body of each text.
 */
async function queuedTexts(t: TestConvex): Promise<{ to: string; body: string }[]> {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return fetchMock.mock.calls.map((call) => {
    const form = (call[1] as RequestInit).body as URLSearchParams;
    return { to: form.get("To")!, body: form.get("Body")! };
  });
}

/**
 * purpose: The code in the most recent text.
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

  test("rejects a number outside the allowed countries by default", async () => {
    const { t, householdId } = await setup();
    await expect(
      t
        .withIdentity({ subject: "pat" })
        .mutation(api.households.setMyPhone, { householdId, phone: "+44 20 7183 8750" }),
    ).rejects.toThrow(/country/);
    expect(await queuedTexts(t)).toHaveLength(0);
  });

  test("accepts an international number when its country code is allowed", async () => {
    const { t, householdId } = await setup();
    vi.stubEnv("SMS_ALLOWED_COUNTRY_CODES", "1,44");
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

  test("only the verification id is scheduled; the code is never in an argument", async () => {
    const { t, householdId } = await setup();
    await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    const scheduled = await t.run(async (ctx) => {
      const rows = await ctx.db.system.query("_scheduled_functions").collect();
      return rows.filter((r) => r.name === "phone:sendCode").map((r) => r.args);
    });
    expect(scheduled).toHaveLength(1);
    expect(Object.keys(scheduled[0]![0] as object)).toEqual(["verificationId"]);
  });

  test("stores only an HMAC of the code", async () => {
    const { t, householdId } = await setup();
    await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    const code = await lastCode(t);
    const rows = await t.run(async (ctx) => await ctx.db.query("phoneVerifications").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
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
    // Each send replaces the caregiver's verification, so only the latest one is texted.
    expect(await queuedTexts(t)).toHaveLength(1);
  });

  test("rate limits sends per caregiver and number: three an hour", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    for (let i = 0; i < 3; i++) {
      await pat.mutation(api.households.setMyPhone, { householdId, phone: "5559990000" });
    }
    vi.advanceTimersByTime(5 * 60_000);
    await expect(
      pat.mutation(api.households.setMyPhone, { householdId, phone: "5559990000" }),
    ).rejects.toThrow(/limit/);
    vi.advanceTimersByTime(61 * 60_000);
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5559990000" });
  });

  test("one caregiver cannot spend another caregiver's budget for a number", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    for (let i = 0; i < 3; i++) {
      await pat.mutation(api.households.setMyPhone, { householdId, phone: "5559990000" });
    }
    // Pat has used the number up; Max's own attempts for it are unaffected.
    await t
      .withIdentity({ subject: "max" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5559990000" });
  });

  test("rate limits sends per caregiver per day", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    for (let i = 0; i < 10; i++) {
      await pat.mutation(api.households.setMyPhone, {
        householdId,
        phone: `555123${String(1000 + i)}`,
      });
      vi.advanceTimersByTime(61_000);
    }
    await expect(
      pat.mutation(api.households.setMyPhone, { householdId, phone: "5551239999" }),
    ).rejects.toThrow(/limit/);
  });

  test("rate limits sends per household per day", async () => {
    const { t, householdId } = await setup();
    const users = ["pat", "max", "val"];
    for (let i = 0; i < 20; i++) {
      await t
        .withIdentity({ subject: users[i % 3]! })
        .mutation(api.households.setMyPhone, { householdId, phone: `555124${String(1000 + i)}` });
      vi.advanceTimersByTime(61_000);
    }
    await expect(
      t
        .withIdentity({ subject: "val" })
        .mutation(api.households.setMyPhone, { householdId, phone: "5551249999" }),
    ).rejects.toThrow(/limit/);
  });

  test("a failed send is reported by confirmMyPhone as send_failed", async () => {
    const { t, householdId } = await setup();
    fetchMock.mockResolvedValue(Response.json({ code: 21211, message: "bad" }, { status: 400 }));
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await queuedTexts(t);
    expect(
      await pat.mutation(api.households.confirmMyPhone, { householdId, code: "123456" }),
    ).toEqual({ status: "send_failed" });
  });

  test("a missing key makes the send fail without texting", async () => {
    const { t, householdId } = await setup();
    vi.stubEnv("CALENDAR_TOKEN_KEY", "");
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    expect(await queuedTexts(t)).toHaveLength(0);
    expect(
      await pat.mutation(api.households.confirmMyPhone, { householdId, code: "123456" }),
    ).toEqual({ status: "send_failed" });
  });

  test("before the text is made the status is sending", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    expect(
      await pat.mutation(api.households.confirmMyPhone, { householdId, code: "123456" }),
    ).toEqual({ status: "sending" });
  });

  test("a late send for a replaced verification texts nothing", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    const [oldRow] = await t.run(async (ctx) => await ctx.db.query("phoneVerifications").collect());
    vi.advanceTimersByTime(61_000);
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await t.action(internal.phone.sendCode, { verificationId: oldRow!._id });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("myPhoneStatus", () => {
  test("is none before any number is added", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    expect(await pat.query(api.households.myPhoneStatus, { householdId })).toEqual({
      status: "none",
    });
  });

  test("is sending until the text is made, then sent with the pending number", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    expect(await pat.query(api.households.myPhoneStatus, { householdId })).toEqual({
      status: "sending",
    });
    await queuedTexts(t);
    expect(await pat.query(api.households.myPhoneStatus, { householdId })).toEqual({
      status: "sent",
      phone: "+15551234567",
      expiresAt: Date.now() + CODE_TTL_MS,
    });
  });

  test("a rejected number is reported with a safe message and no Twilio text", async () => {
    const { t, householdId } = await setup();
    fetchMock.mockResolvedValue(Response.json({ code: 21211, message: "bad" }, { status: 400 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await queuedTexts(t);
    const status = await pat.query(api.households.myPhoneStatus, { householdId });
    expect(status).toEqual({ status: "send_failed", error: BAD_NUMBER_MESSAGE });
    expect(JSON.stringify(status)).not.toMatch(/Twilio|21211/);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Twilio 400 (code 21211)"));
    const [row] = await t.run(async (ctx) => await ctx.db.query("phoneVerifications").collect());
    expect(row!.sendErrorDetail).toContain("Twilio 400 (code 21211)");
  });

  test("another Twilio failure is reported with the generic message", async () => {
    const { t, householdId } = await setup();
    fetchMock.mockResolvedValue(Response.json({ code: 30008, message: "x" }, { status: 400 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await queuedTexts(t);
    expect(await pat.query(api.households.myPhoneStatus, { householdId })).toEqual({
      status: "send_failed",
      error: SEND_FAILED_MESSAGE,
    });
  });

  test("a missing key is reported without naming environment variables", async () => {
    const { t, householdId } = await setup();
    vi.stubEnv("CALENDAR_TOKEN_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await queuedTexts(t);
    const status = await pat.query(api.households.myPhoneStatus, { householdId });
    expect(status).toEqual({ status: "send_failed", error: SEND_FAILED_MESSAGE });
    expect(JSON.stringify(status)).not.toMatch(/CALENDAR_TOKEN_KEY|TWILIO/);
  });

  test("is expired once the code has expired", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await queuedTexts(t);
    vi.advanceTimersByTime(CODE_TTL_MS + 1);
    expect(await pat.query(api.households.myPhoneStatus, { householdId })).toEqual({
      status: "expired",
    });
  });

  test("shows each member only their own verification", async () => {
    const { t, householdId } = await setup();
    await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    expect(
      await t.withIdentity({ subject: "max" }).query(api.households.myPhoneStatus, { householdId }),
    ).toEqual({ status: "none" });
  });

  test("rejects a non-member", async () => {
    const { t, householdId } = await setup();
    await expect(
      t.withIdentity({ subject: "stranger" }).query(api.households.myPhoneStatus, { householdId }),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("clearMyPhone and the sweep", () => {
  test("removes the verified phone, a pending number and the verification", async () => {
    const { t, householdId } = await setup();
    const pat = t.withIdentity({ subject: "pat" });
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    await pat.mutation(api.households.confirmMyPhone, { householdId, code: await lastCode(t) });
    vi.advanceTimersByTime(61_000);
    await pat.mutation(api.households.setMyPhone, { householdId, phone: "5557778888" });
    await pat.mutation(api.households.clearMyPhone, { householdId });
    const me = (await pat.query(api.households.listMembers, { householdId })).find(
      (m) => m.userId === "pat",
    )!;
    expect(me.phoneVerified).toBe(false);
    expect(me.phone).toBeUndefined();
    expect(me.pendingPhone).toBeUndefined();
    expect(await t.run(async (ctx) => await ctx.db.query("phoneVerifications").collect())).toEqual(
      [],
    );
  });

  test("a non-member cannot clear and a viewer can clear their own", async () => {
    const { t, householdId } = await setup();
    await expect(
      t
        .withIdentity({ subject: "stranger" })
        .mutation(api.households.clearMyPhone, { householdId }),
    ).rejects.toThrow(/forbidden/);
    await t.withIdentity({ subject: "val" }).mutation(api.households.clearMyPhone, { householdId });
  });

  test("sweepExpired deletes expired verifications and their pending number only", async () => {
    const { t, householdId } = await setup();
    await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5551234567" });
    vi.advanceTimersByTime(5 * 60_000);
    await t
      .withIdentity({ subject: "max" })
      .mutation(api.households.setMyPhone, { householdId, phone: "5557778888" });
    vi.advanceTimersByTime(CODE_TTL_MS - 5 * 60_000 + 1_000);
    expect(await t.mutation(internal.phone.sweepExpired, {})).toBe(1);
    const members = await t
      .withIdentity({ subject: "pat" })
      .query(api.households.listMembers, { householdId });
    expect(members.find((m) => m.userId === "pat")!.pendingPhone).toBeUndefined();
    expect(members.find((m) => m.userId === "max")!.pendingPhone).toBe("+15557778888");
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

  test("input longer than a code is rejected without counting an attempt", async () => {
    const { t, householdId } = await started();
    await expect(
      t
        .withIdentity({ subject: "pat" })
        .mutation(api.households.confirmMyPhone, { householdId, code: "1".repeat(40) }),
    ).rejects.toThrow(/invalid/);
    const [row] = await t.run(async (ctx) => await ctx.db.query("phoneVerifications").collect());
    expect(row!.attempts).toBe(0);
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
