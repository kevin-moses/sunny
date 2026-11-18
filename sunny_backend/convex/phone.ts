import { MINUTE, HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
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

const rateLimiter = new RateLimiter(components.rateLimiter, {
  phoneCodePerUser: { kind: "token bucket", rate: 1, period: MINUTE, capacity: 3 },
  phoneCodePerUserNumber: { kind: "token bucket", rate: 3, period: HOUR, capacity: 3 },
  phoneCodePerUserDay: { kind: "fixed window", rate: 10, period: 24 * HOUR },
  phoneCodePerHouseholdDay: { kind: "fixed window", rate: 20, period: 24 * HOUR },
});

export type ConfirmPhoneResult =
  | { status: "verified"; phone: string }
  | { status: "wrong_code"; attemptsLeft: number }
  | { status: "expired" }
  | { status: "locked" }
  | { status: "sending" }
  | { status: "send_failed" }
  | { status: "none" };

export const SEND_FAILED_MESSAGE = "The code text could not be sent. Try again later.";
export const BAD_NUMBER_MESSAGE = "That number cannot receive texts.";
const TWILIO_INVALID_TO_NUMBER = 21211;
const TWILIO_TO_NOT_MOBILE = 21614;
const BAD_NUMBER_CODES: ReadonlySet<number> = new Set([
  TWILIO_INVALID_TO_NUMBER,
  TWILIO_TO_NOT_MOBILE,
]);

export type MyPhoneStatus =
  | { status: "none" }
  | { status: "expired" }
  | { status: "sending" }
  | { status: "sent"; phone: string; expiresAt: number }
  | { status: "send_failed"; error: string };

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(n % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
}

async function hashCode(userId: string, phone: string, code: string): Promise<string> {
  return await hmacHex(CODE_KEY_LABEL, `${userId}|${phone}|${code}`);
}

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

export const verificationTarget = internalQuery({
  args: { verificationId: v.id("phoneVerifications") },
  handler: async (ctx, { verificationId }): Promise<{ userId: string; phone: string } | null> => {
    const row = await ctx.db.get(verificationId);
    return row ? { userId: row.userId, phone: row.phone } : null;
  },
});

export const storeCode = internalMutation({
  args: { verificationId: v.id("phoneVerifications"), codeHash: v.string() },
  handler: async (ctx, { verificationId, codeHash }): Promise<boolean> => {
    const row = await ctx.db.get(verificationId);
    if (!row) return false;
    await ctx.db.patch(verificationId, {
      codeHash,
      sendError: undefined,
      sendErrorDetail: undefined,
    });
    return true;
  },
});

export const markSendFailed = internalMutation({
  args: { verificationId: v.id("phoneVerifications"), error: v.string(), detail: v.string() },
  handler: async (ctx, { verificationId, error, detail }): Promise<null> => {
    if (await ctx.db.get(verificationId)) {
      await ctx.db.patch(verificationId, { sendError: error, sendErrorDetail: detail });
    }
    return null;
  },
});

export const sendCode = internalAction({
  args: { verificationId: v.id("phoneVerifications") },
  handler: async (ctx, { verificationId }): Promise<null> => {
    const target = await ctx.runQuery(internal.phone.verificationTarget, { verificationId });
    if (target === null) return null;
    const fail = async (error: string, detail: string): Promise<null> => {
      console.error(`Phone verification code text failed: ${detail}`);
      await ctx.runMutation(internal.phone.markSendFailed, { verificationId, error, detail });
      return null;
    };
    const code = randomCode();
    let codeHash: string;
    try {
      codeHash = await hashCode(target.userId, target.phone, code);
    } catch (e) {
      if (e instanceof ConfigError) return await fail(SEND_FAILED_MESSAGE, e.message);
      throw e;
    }
    if (!(await ctx.runMutation(internal.phone.storeCode, { verificationId, codeHash }))) {
      return null;
    }
    const result = await sendSmsFromEnv(
      target.phone,
      `Sunny code: ${code}. It expires in 10 minutes. Reply STOP to opt out.`,
    );
    if (result.ok) return null;
    return await fail(
      result.twilioCode !== undefined && BAD_NUMBER_CODES.has(result.twilioCode)
        ? BAD_NUMBER_MESSAGE
        : SEND_FAILED_MESSAGE,
      result.error,
    );
  },
});

export const myPhoneStatus = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<MyPhoneStatus> => {
    const userId = await requireCaregiverAccount(ctx);
    await requireCaregiverMember(ctx, args.householdId, userId);
    const row = await ctx.db
      .query("phoneVerifications")
      .withIndex("by_household_user", (q) =>
        q.eq("householdId", args.householdId).eq("userId", userId),
      )
      .unique();
    if (!row) return { status: "none" };
    if (Date.now() >= row.expiresAt) return { status: "expired" };
    if (row.sendError !== undefined) return { status: "send_failed", error: row.sendError };
    if (row.codeHash === undefined) return { status: "sending" };
    return { status: "sent", phone: row.phone, expiresAt: row.expiresAt };
  },
});

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
