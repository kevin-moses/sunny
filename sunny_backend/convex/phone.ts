// convex/phone.ts
// Purpose: Caregiver phone numbers and their verification. setMyPhone normalizes a number to
// E.164 (a 10-digit US number gets +1), stores it as the member's pendingPhone and texts a
// 6-digit code through internal.sms.send (scheduled, so the mutation never waits on
// Twilio). The code is stored only as a SHA-256 hash bound to the user and number, expires
// after 10 minutes and allows 5 wrong guesses; sending is rate limited per caregiver (a
// burst of 3, then one a minute) and per number (3 an hour). confirmMyPhone checks the code
// and, on success, makes the number the member's phone with phoneVerifiedAt set. Only
// verified numbers are reachable by SMS (see sms.ts). The two mutations are exported from
// households.ts as households.setMyPhone and households.confirmMyPhone. Wrong guesses are
// returned as a status, not thrown, so the attempt count is saved.
//
// Last modified: 2026-10-29

import { MINUTE, HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireCaregiverAccount, requireCaregiverMember } from "./lib/access";
import { appError } from "./lib/errors";
import { constantTimeEqual } from "./lib/secretBox";
import { normalizePhone, twilioConfig } from "./lib/twilio";

export const CODE_TTL_MS = 10 * MINUTE;
export const MAX_CODE_ATTEMPTS = 5;
const CODE_LENGTH = 6;

/** Verification text sends: per caregiver a burst of 3 then 1 a minute; per number 3 an hour. */
const rateLimiter = new RateLimiter(components.rateLimiter, {
  phoneCodePerUser: { kind: "token bucket", rate: 1, period: MINUTE, capacity: 3 },
  phoneCodePerNumber: { kind: "token bucket", rate: 3, period: HOUR, capacity: 3 },
});

/** Result of confirmMyPhone; every status but "verified" leaves the number unverified. */
export type ConfirmPhoneResult =
  | { status: "verified"; phone: string }
  | { status: "wrong_code"; attemptsLeft: number }
  | { status: "expired" }
  | { status: "locked" }
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
 * purpose: Hash a code for storage, bound to the user and number so a stolen hash cannot be
 *          replayed for another member.
 * @param userId: (string) Member's user id.
 * @param phone: (string) E.164 number being verified.
 * @param code: (string) The code.
 * @return: (Promise<string>) Hex SHA-256.
 */
export async function hashCode(userId: string, phone: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${userId}|${phone}|${code}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
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
 * purpose: Spend the send rate limits for a caregiver and a number.
 * @param ctx: (MutationCtx) Context.
 * @param userId: (string) Caregiver's user id.
 * @param phone: (string) E.164 number.
 * @return: (Promise<void>)
 * @raises limit when either bucket is empty.
 */
async function spendSendLimits(ctx: MutationCtx, userId: string, phone: string): Promise<void> {
  const user = await rateLimiter.limit(ctx, "phoneCodePerUser", { key: userId });
  const number = await rateLimiter.limit(ctx, "phoneCodePerNumber", { key: phone });
  if (!user.ok || !number.ok) {
    throw appError("limit", "Too many verification texts; wait a few minutes and try again");
  }
}

/**
 * purpose: Start verifying the caller's phone number: store it as pending and text a code.
 *          Any caregiver member (including viewers) may add a number for themselves. A resend
 *          replaces the earlier code and resets the attempt count.
 * @param householdId: (Id<"households">) Household the caller belongs to.
 * @param phone: (string) Number as typed; E.164, or a 10-digit US number.
 * @return: ({phone, expiresAt}) The normalized number and when the code expires.
 * @raises forbidden for a non-member or device; invalid for a bad number or when texting is
 *         not set up; limit when sending too often.
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
    try {
      twilioConfig();
    } catch {
      throw appError("invalid", "Text messages are not available yet");
    }
    await spendSendLimits(ctx, userId, phone);

    const code = randomCode();
    const expiresAt = Date.now() + CODE_TTL_MS;
    const row = {
      householdId: args.householdId,
      userId,
      phone,
      codeHash: await hashCode(userId, phone, code),
      expiresAt,
      attempts: 0,
    };
    const existing = await findVerification(ctx, args.householdId, userId);
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("phoneVerifications", row);
    await ctx.db.patch(member._id, { pendingPhone: phone });
    await ctx.scheduler.runAfter(0, internal.sms.send, {
      to: phone,
      body: `Sunny code: ${code}. It expires in 10 minutes. Reply STOP to opt out.`,
    });
    return { phone, expiresAt };
  },
});

/**
 * purpose: Check the texted code. A correct code (before expiry, within 5 wrong guesses)
 *          makes the pending number the member's verified phone. A wrong code counts an
 *          attempt; the fifth wrong guess locks the code until a new one is sent.
 * @param householdId: (Id<"households">) Household the caller belongs to.
 * @param code: (string) The 6-digit code as typed.
 * @return: (ConfirmPhoneResult) "verified" with the number, "wrong_code" with attempts left,
 *          "expired", "locked", or "none" when no verification is pending.
 * @raises forbidden for a non-member or device.
 */
export const confirmMyPhone = mutation({
  args: { householdId: v.id("households"), code: v.string() },
  handler: async (ctx, args): Promise<ConfirmPhoneResult> => {
    const userId = await requireCaregiverAccount(ctx);
    const member = await requireCaregiverMember(ctx, args.householdId, userId);
    const row = await findVerification(ctx, args.householdId, userId);
    if (!row) return { status: "none" };
    if (Date.now() >= row.expiresAt) {
      await ctx.db.delete(row._id);
      await ctx.db.patch(member._id, { pendingPhone: undefined });
      return { status: "expired" };
    }
    if (row.attempts >= MAX_CODE_ATTEMPTS) return { status: "locked" };
    const given = await hashCode(userId, row.phone, args.code.trim());
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
