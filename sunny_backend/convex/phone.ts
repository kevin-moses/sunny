// convex/phone.ts
// Purpose: Caregiver phone numbers and their verification. setMyPhone normalizes a number to
// E.164, requires an allowed country (SMS_ALLOWED_COUNTRY_CODES, default "1"), stores it as the
// member's pendingPhone and schedules sendCode with only the verification id: the action makes
// the 6-digit code, stores its HMAC (key derived from CALENDAR_TOKEN_KEY, label
// "sunny-phone-code", bound to user and number) and texts it, so the code is never in a
// scheduled-function argument or a table. A failed send is saved on the row and reported by
// confirmMyPhone as "send_failed". Codes expire after 10 minutes and allow 5 wrong guesses.
// Sending is limited per caregiver (burst of 3, then one a minute), per caregiver and number (3
// an hour, so one caregiver cannot use up another's budget for a number), and per day for each
// caregiver and each household. confirmMyPhone makes the number the member's phone with
// phoneVerifiedAt set; clearMyPhone removes it; sweepExpired (hourly) deletes stale rows.
// setMyPhone, confirmMyPhone and clearMyPhone are re-exported by households.ts. Wrong guesses
// are returned as a status, not thrown, so the attempt count is saved.
//
// Last modified: 2026-10-29

import { MINUTE, HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireCaregiverAccount, requireCaregiverMember } from "./lib/access";
import { ConfigError, appError } from "./lib/errors";
import { constantTimeEqual, hmacHex } from "./lib/secretBox";
import { isAllowedCountry, normalizePhone, sendSmsFromEnv, twilioConfig } from "./lib/twilio";

export const CODE_TTL_MS = 10 * MINUTE;
export const MAX_CODE_ATTEMPTS = 5;
const CODE_LENGTH = 6;
const MAX_CODE_INPUT = 16;
const CODE_KEY_LABEL = "sunny-phone-code";
const SWEEP_BATCH = 200;

/**
 * Verification text sends: per caregiver a burst of 3 then 1 a minute; per caregiver and number
 * 3 an hour; per caregiver 10 a day and per household 20 a day.
 */
const rateLimiter = new RateLimiter(components.rateLimiter, {
  phoneCodePerUser: { kind: "token bucket", rate: 1, period: MINUTE, capacity: 3 },
  phoneCodePerUserNumber: { kind: "token bucket", rate: 3, period: HOUR, capacity: 3 },
  phoneCodePerUserDay: { kind: "fixed window", rate: 10, period: 24 * HOUR },
  phoneCodePerHouseholdDay: { kind: "fixed window", rate: 20, period: 24 * HOUR },
});

/** Result of confirmMyPhone; every status but "verified" leaves the number unverified. */
export type ConfirmPhoneResult =
  | { status: "verified"; phone: string }
  | { status: "wrong_code"; attemptsLeft: number }
  | { status: "expired" }
  | { status: "locked" }
  | { status: "sending" }
  | { status: "send_failed" }
  | { status: "none" };

/**
 * purpose: A random 6-digit code, zero padded.
 * @return: (string) Digits only.
 */
function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(n % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
}

/**
 * purpose: HMAC a code for storage, bound to the user and number so a stolen hash cannot be
 *          replayed for another member. The key is derived from CALENDAR_TOKEN_KEY.
 * @param userId: (string) Member's user id.
 * @param phone: (string) E.164 number being verified.
 * @param code: (string) The code.
 * @return: (Promise<string>) Hex HMAC-SHA256.
 * @raises ConfigError when CALENDAR_TOKEN_KEY is missing or malformed.
 */
async function hashCode(userId: string, phone: string, code: string): Promise<string> {
  return await hmacHex(CODE_KEY_LABEL, `${userId}|${phone}|${code}`);
}

/**
 * purpose: The member's outstanding verification row, if any.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Member's user id.
 * @return: (Promise<Doc<"phoneVerifications"> | null>) The row, or null.
 */
async function findVerification(
  ctx: MutationCtx,
  householdId: Id<"households">,
  userId: string,
): Promise<Doc<"phoneVerifications"> | null> {
  return await ctx.db
    .query("phoneVerifications")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId).eq("userId", userId))
    .unique();
}

/**
 * purpose: Spend the send rate limits for a caregiver, a caregiver's number, and the day.
 * @param ctx: (MutationCtx) Context.
 * @param userId: (string) Caregiver's user id.
 * @param householdId: (Id<"households">) Caregiver's household.
 * @param phone: (string) E.164 number.
 * @return: (Promise<void>)
 * @raises limit when any bucket is empty.
 */
async function spendSendLimits(
  ctx: MutationCtx,
  userId: string,
  householdId: Id<"households">,
  phone: string,
): Promise<void> {
  const results = [
    await rateLimiter.limit(ctx, "phoneCodePerUser", { key: userId }),
    await rateLimiter.limit(ctx, "phoneCodePerUserNumber", { key: `${userId}|${phone}` }),
    await rateLimiter.limit(ctx, "phoneCodePerUserDay", { key: userId }),
    await rateLimiter.limit(ctx, "phoneCodePerHouseholdDay", { key: householdId }),
  ];
  if (results.some((r) => !r.ok)) {
    throw appError("limit", "Too many verification texts; wait a while and try again");
  }
}

/**
 * purpose: Start verifying the caller's phone number: store it as pending and schedule the
 *          code text. Any caregiver member (including viewers) may add a number for themselves.
 *          A resend replaces the earlier verification (a new row, so a late send for the old
 *          one does nothing) and resets the attempt count.
 * @param householdId: (Id<"households">) Household the caller belongs to.
 * @param phone: (string) Number as typed; E.164, or a 10-digit US number.
 * @return: ({phone, expiresAt}) The normalized number and when the code expires.
 * @raises forbidden for a non-member or device; invalid for a bad number, a country that is
 *         not allowed, or when texting is not set up; limit when sending too often.
 */
export const setMyPhone = mutation({
  args: { householdId: v.id("households"), phone: v.string() },
  handler: async (ctx, args): Promise<{ phone: string; expiresAt: number }> => {
    const userId = await requireCaregiverAccount(ctx);
    const member = await requireCaregiverMember(ctx, args.householdId, userId);
    const phone = normalizePhone(args.phone);
    if (phone === null) {
      throw appError("invalid", "Enter a mobile number like 555-123-4567, or +country code");
    }
    if (!isAllowedCountry(phone)) {
      throw appError("invalid", "Sunny cannot text numbers in that country yet");
    }
    try {
      twilioConfig();
    } catch {
      throw appError("invalid", "Text messages are not available yet");
    }
    await spendSendLimits(ctx, userId, args.householdId, phone);

    const existing = await findVerification(ctx, args.householdId, userId);
    if (existing) await ctx.db.delete(existing._id);
    const expiresAt = Date.now() + CODE_TTL_MS;
    const verificationId = await ctx.db.insert("phoneVerifications", {
      householdId: args.householdId,
      userId,
      phone,
      expiresAt,
      attempts: 0,
    });
    await ctx.db.patch(member._id, { pendingPhone: phone });
    await ctx.scheduler.runAfter(0, internal.phone.sendCode, { verificationId });
    return { phone, expiresAt };
  },
});

/**
 * purpose: The user and number a verification is for. Internal; read by sendCode.
 * @param verificationId: (Id<"phoneVerifications">) The verification.
 * @return: ({userId, phone} | null) Null when the row is gone (replaced, cleared or swept).
 */
export const verificationTarget = internalQuery({
  args: { verificationId: v.id("phoneVerifications") },
  handler: async (ctx, { verificationId }): Promise<{ userId: string; phone: string } | null> => {
    const row = await ctx.db.get(verificationId);
    return row ? { userId: row.userId, phone: row.phone } : null;
  },
});

/**
 * purpose: Store the HMAC of a freshly made code on its verification. Internal.
 * @param verificationId: (Id<"phoneVerifications">) The verification.
 * @param codeHash: (string) HMAC of the code.
 * @return: (boolean) False when the row is gone, so the code must not be sent.
 */
export const storeCode = internalMutation({
  args: { verificationId: v.id("phoneVerifications"), codeHash: v.string() },
  handler: async (ctx, { verificationId, codeHash }): Promise<boolean> => {
    const row = await ctx.db.get(verificationId);
    if (!row) return false;
    await ctx.db.patch(verificationId, { codeHash, sendError: undefined });
    return true;
  },
});

/**
 * purpose: Record that the code text could not be sent, for confirmMyPhone to report. Internal.
 * @param verificationId: (Id<"phoneVerifications">) The verification.
 * @param error: (string) What went wrong (not shown to the caregiver).
 * @return: (null)
 */
export const markSendFailed = internalMutation({
  args: { verificationId: v.id("phoneVerifications"), error: v.string() },
  handler: async (ctx, { verificationId, error }): Promise<null> => {
    if (await ctx.db.get(verificationId)) await ctx.db.patch(verificationId, { sendError: error });
    return null;
  },
});

/**
 * purpose: Make the code, store its HMAC and text it. Only the verification id travels in the
 *          scheduled arguments. A failure (configuration, Twilio) is saved on the row.
 * @param verificationId: (Id<"phoneVerifications">) The verification.
 * @return: (null)
 */
export const sendCode = internalAction({
  args: { verificationId: v.id("phoneVerifications") },
  handler: async (ctx, { verificationId }): Promise<null> => {
    const target = await ctx.runQuery(internal.phone.verificationTarget, { verificationId });
    if (target === null) return null;
    /**
     * purpose: Save a send failure on the verification.
     * @param error: (string) What went wrong.
     * @return: (Promise<null>) Always null.
     */
    const fail = async (error: string): Promise<null> => {
      await ctx.runMutation(internal.phone.markSendFailed, { verificationId, error });
      return null;
    };
    const code = randomCode();
    let codeHash: string;
    try {
      codeHash = await hashCode(target.userId, target.phone, code);
    } catch (e) {
      if (e instanceof ConfigError) return await fail(e.message);
      throw e;
    }
    if (!(await ctx.runMutation(internal.phone.storeCode, { verificationId, codeHash }))) {
      return null;
    }
    const result = await sendSmsFromEnv(
      target.phone,
      `Sunny code: ${code}. It expires in 10 minutes. Reply STOP to opt out.`,
    );
    return result.ok ? null : await fail(result.error);
  },
});

/**
 * purpose: Check the texted code. A correct code (before expiry, within 5 wrong guesses)
 *          makes the pending number the member's verified phone. A wrong code counts an
 *          attempt; the fifth wrong guess locks the code until a new one is sent.
 * @param householdId: (Id<"households">) Household the caller belongs to.
 * @param code: (string) The 6-digit code as typed.
 * @return: (ConfirmPhoneResult) "verified" with the number, "wrong_code" with attempts left,
 *          "expired", "locked", "sending" (the code text has not been made yet), "send_failed"
 *          (the text could not be sent; start again), or "none" when nothing is pending.
 * @raises forbidden for a non-member or device; invalid for input longer than a code.
 */
export const confirmMyPhone = mutation({
  args: { householdId: v.id("households"), code: v.string() },
  handler: async (ctx, args): Promise<ConfirmPhoneResult> => {
    const userId = await requireCaregiverAccount(ctx);
    const member = await requireCaregiverMember(ctx, args.householdId, userId);
    const code = args.code.trim();
    if (code.length > MAX_CODE_INPUT) throw appError("invalid", "Enter the 6-digit code");
    const row = await findVerification(ctx, args.householdId, userId);
    if (!row) return { status: "none" };
    if (Date.now() >= row.expiresAt) {
      await ctx.db.delete(row._id);
      await ctx.db.patch(member._id, { pendingPhone: undefined });
      return { status: "expired" };
    }
    if (row.sendError !== undefined) return { status: "send_failed" };
    if (row.codeHash === undefined) return { status: "sending" };
    if (row.attempts >= MAX_CODE_ATTEMPTS) return { status: "locked" };
    const given = await hashCode(userId, row.phone, code);
    if (!constantTimeEqual(given, row.codeHash)) {
      const attempts = row.attempts + 1;
      await ctx.db.patch(row._id, { attempts });
      return attempts >= MAX_CODE_ATTEMPTS
        ? { status: "locked" }
        : { status: "wrong_code", attemptsLeft: MAX_CODE_ATTEMPTS - attempts };
    }
    await ctx.db.patch(member._id, {
      phone: row.phone,
      phoneVerifiedAt: Date.now(),
      pendingPhone: undefined,
    });
    await ctx.db.delete(row._id);
    return { status: "verified", phone: row.phone };
  },
});

/**
 * purpose: Remove the caller's phone number: the verified phone, any pending one and any
 *          outstanding verification. The member stops receiving texts.
 * @param householdId: (Id<"households">) Household the caller belongs to.
 * @return: (null)
 * @raises forbidden for a non-member or device.
 */
export const clearMyPhone = mutation({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireCaregiverAccount(ctx);
    const member = await requireCaregiverMember(ctx, args.householdId, userId);
    const row = await findVerification(ctx, args.householdId, userId);
    if (row) await ctx.db.delete(row._id);
    await ctx.db.patch(member._id, {
      phone: undefined,
      phoneVerifiedAt: undefined,
      pendingPhone: undefined,
    });
    return null;
  },
});

/**
 * purpose: Delete verifications past their expiry and clear the pending number they left on
 *          the member (hourly cron). Internal.
 * @return: (number) Rows deleted (at most one batch per run).
 */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const stale = await ctx.db
      .query("phoneVerifications")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(SWEEP_BATCH);
    for (const row of stale) {
      const member = await ctx.db
        .query("householdMembers")
        .withIndex("by_household_user", (q) =>
          q.eq("householdId", row.householdId).eq("userId", row.userId),
        )
        .unique();
      if (member && member.pendingPhone === row.phone) {
        await ctx.db.patch(member._id, { pendingPhone: undefined });
      }
      await ctx.db.delete(row._id);
    }
    return stale.length;
  },
});
