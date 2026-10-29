// households.ts
// Purpose: Household identity, ported from the Supabase households migration: creating a
// household, its settings, caregiver members and roles, one-time join codes (invite a
// caregiver, pair a device), paired devices, and push tokens. Access rules that RLS
// enforced are enforced here with lib/access (viewers read only, editors change data,
// primaries manage members). Device codes are redeemed by the internal pairDevice
// mutation, called from the /pair HTTP action once a Clerk user exists for the device.
//
// Last modified: 2026-10-28

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import {
  currentUserId,
  findDevice,
  findMember,
  myHouseholdIds,
  requireCaregiverAccount,
  requireEditor,
  requirePrimary,
  requireReader,
  requireUserId,
} from "./lib/access";
import { appError } from "./lib/errors";
import { seedDefaultPolicies } from "./lib/policies";
import { resyncHouseholdTimezone } from "./lib/schedule";
import { canonicalTimezone, isLocalTime } from "./lib/time";
import { joinGrant, memberRole } from "./lib/validators";
import type { DeviceKind, JoinGrant, MemberRole } from "./lib/validators";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ATTEMPTS = 10;
const DEFAULT_CAREGIVER_NAME = "Caregiver";

/**
 * purpose: Reject a blank string.
 * @param value: (string) Candidate.
 * @param label: (string) Field name for the error message.
 * @return: (string) The trimmed value.
 */
function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw appError("invalid", `${label} cannot be blank`);
  return trimmed;
}

/**
 * purpose: Validate an IANA timezone and return its canonical spelling.
 * @param timezone: (string) Candidate zone.
 * @return: (string) Canonical zone, e.g. "America/New_York" for "america/new_york".
 * @raises invalid when the zone is not a usable region zone.
 */
function requireTimezone(timezone: string): string {
  const canonical = canonicalTimezone(timezone);
  if (canonical === null) throw appError("invalid", `Unknown timezone ${timezone}`);
  return canonical;
}

/**
 * purpose: Reject a malformed "HH:MM" time.
 * @param time: (string) Candidate time.
 * @param label: (string) Field name for the error message.
 * @return: (void)
 */
function assertTime(time: string, label: string): void {
  if (!isLocalTime(time)) throw appError("invalid", `${label} must be HH:MM`);
}

/**
 * purpose: Draw a random join code from the unambiguous alphabet.
 * @return: (string) Eight characters. The alphabet has 32 letters, so byte % 32 is unbiased.
 */
function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/**
 * purpose: Find a join code row; the code is trimmed and upper-cased here.
 * @param ctx: (QueryCtx) Context.
 * @param code: (string) Code as typed or stored.
 * @return: (Doc<"joinCodes"> | null) The row, or null.
 */
async function findJoinCode(ctx: QueryCtx, code: string): Promise<Doc<"joinCodes"> | null> {
  return await ctx.db
    .query("joinCodes")
    .withIndex("by_code", (q) => q.eq("code", code.trim().toUpperCase()))
    .unique();
}

/**
 * purpose: Load a join code that can still be redeemed.
 * @param ctx: (QueryCtx) Context.
 * @param rawCode: (string) Code as typed.
 * @param now: (number) Epoch ms.
 * @return: (Doc<"joinCodes">) The redeemable row.
 * @raises not_found when the code does not exist, was used, or has expired.
 */
async function loadRedeemableCode(
  ctx: QueryCtx,
  rawCode: string,
  now: number,
): Promise<Doc<"joinCodes">> {
  const row = await findJoinCode(ctx, rawCode);
  if (!row || row.redeemedAt !== undefined || row.expiresAt <= now) throw invalidCodeError();
  return row;
}

/**
 * purpose: The one error for every unredeemable code (unknown, used, expired, or the wrong
 *          kind for the redeeming path), so a code's kind is never revealed.
 * @return: (Error) A not_found app error.
 */
function invalidCodeError(): Error {
  return appError("not_found", "This code is invalid or has expired");
}

/**
 * purpose: Whether a join grant adds a senior device rather than a caregiver.
 * @param grant: (JoinGrant) The grant on a code.
 * @return: (boolean) True for senior_phone and home_display.
 */
function isDeviceGrant(grant: JoinGrant): grant is DeviceKind {
  return grant === "senior_phone" || grant === "home_display";
}

/**
 * purpose: Create a household with the caller as primary caregiver and on-call contact.
 * @param seniorPreferredName: (string) What the senior likes to be called.
 * @param timezone: (string) IANA zone of the household.
 * @param caregiverDisplayName: (string) The caller's display name.
 * @return: (Id<"households">) The new household.
 */
export const create = mutation({
  args: {
    seniorPreferredName: v.string(),
    timezone: v.string(),
    caregiverDisplayName: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"households">> => {
    const userId = await requireCaregiverAccount(ctx);
    const seniorPreferredName = requireNonBlank(args.seniorPreferredName, "Senior's name");
    const displayName = requireNonBlank(args.caregiverDisplayName, "Your name");
    const timezone = requireTimezone(args.timezone);

    const householdId = await ctx.db.insert("households", {
      seniorPreferredName,
      timezone,
      onCallUserId: userId,
      digestTime: "19:00",
      eventNoticeTime: "08:00",
      shareTranscripts: false,
      backgroundPaused: false,
    });
    await ctx.db.insert("householdMembers", {
      householdId,
      userId,
      role: "primary",
      displayName,
    });
    await seedDefaultPolicies(ctx, householdId);
    return householdId;
  },
});

/**
 * purpose: Households the caller belongs to, as a caregiver (with role) or as a paired device.
 * @return: (Array<{household, role, deviceKind}>) role is null for a device; deviceKind is
 *          null for a caregiver. Empty when signed out.
 */
export const mine = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    Array<{ household: Doc<"households">; role: MemberRole | null; deviceKind: DeviceKind | null }>
  > => {
    const ids = await myHouseholdIds(ctx);
    const userId = await currentUserId(ctx);
    const device = userId === null ? null : await findDevice(ctx, userId);
    const result = [];
    for (const id of ids) {
      const household = await ctx.db.get(id);
      if (!household) continue;
      const member = userId === null ? null : await findMember(ctx, id, userId);
      result.push({
        household,
        role: member ? member.role : null,
        deviceKind: !member && device && device.householdId === id ? device.kind : null,
      });
    }
    return result;
  },
});

/**
 * purpose: One household's settings.
 * @param householdId: (Id<"households">) Household.
 * @return: (Doc<"households">) The household. Readers only.
 */
export const get = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<Doc<"households">> => {
    await requireReader(ctx, args.householdId);
    const household = await ctx.db.get(args.householdId);
    if (!household) throw appError("not_found", "Household not found");
    return household;
  },
});

/**
 * purpose: Change household settings; fields left out are unchanged. Editors only.
 * @param householdId: (Id<"households">) Household.
 * @param seniorPreferredName: (string, optional) Non-blank name.
 * @param seniorFullName: (string, optional) Full name.
 * @param timezone: (string, optional) IANA zone.
 * @param onCallUserId: (string, optional) Must be a member of the household.
 * @param digestTime: (string, optional) Local "HH:MM".
 * @param eventNoticeTime: (string, optional) Local "HH:MM".
 * @param shareTranscripts: (boolean, optional) Whether caregivers see full transcripts.
 * @param backgroundPaused: (boolean, optional) Caregiver "stop" switch.
 * @return: (null)
 */
export const update = mutation({
  args: {
    householdId: v.id("households"),
    seniorPreferredName: v.optional(v.string()),
    seniorFullName: v.optional(v.string()),
    timezone: v.optional(v.string()),
    onCallUserId: v.optional(v.string()),
    digestTime: v.optional(v.string()),
    eventNoticeTime: v.optional(v.string()),
    shareTranscripts: v.optional(v.boolean()),
    backgroundPaused: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<null> => {
    await requireEditor(ctx, args.householdId);
    const household = await ctx.db.get(args.householdId);
    if (!household) throw appError("not_found", "Household not found");

    const { householdId, ...fields } = args;
    const patch: Partial<Omit<Doc<"households">, "_id" | "_creationTime">> = {};
    if (fields.seniorPreferredName !== undefined) {
      patch.seniorPreferredName = requireNonBlank(fields.seniorPreferredName, "Senior's name");
    }
    if (fields.seniorFullName !== undefined) patch.seniorFullName = fields.seniorFullName;
    if (fields.timezone !== undefined) {
      patch.timezone = requireTimezone(fields.timezone);
      if (patch.timezone !== household.timezone) {
        // The resync reads the household's zone, so write it before expanding.
        await ctx.db.patch(householdId, { timezone: patch.timezone });
        await resyncHouseholdTimezone(ctx, householdId, Date.now());
      }
    }
    if (fields.onCallUserId !== undefined) {
      if (!(await findMember(ctx, householdId, fields.onCallUserId))) {
        throw appError("invalid", "The on-call caregiver must be a member of the household");
      }
      patch.onCallUserId = fields.onCallUserId;
    }
    if (fields.digestTime !== undefined) {
      assertTime(fields.digestTime, "Digest time");
      patch.digestTime = fields.digestTime;
    }
    if (fields.eventNoticeTime !== undefined) {
      assertTime(fields.eventNoticeTime, "Event notice time");
      patch.eventNoticeTime = fields.eventNoticeTime;
    }
    if (fields.shareTranscripts !== undefined) patch.shareTranscripts = fields.shareTranscripts;
    if (fields.backgroundPaused !== undefined) patch.backgroundPaused = fields.backgroundPaused;

    await ctx.db.patch(householdId, patch);
    return null;
  },
});

/**
 * purpose: The household's caregivers.
 * @param householdId: (Id<"households">) Household.
 * @return: (Doc<"householdMembers">[]) Members. Readers only.
 */
export const listMembers = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<Doc<"householdMembers">[]> => {
    await requireReader(ctx, args.householdId);
    return await ctx.db
      .query("householdMembers")
      .withIndex("by_household_user", (q) => q.eq("householdId", args.householdId))
      .collect();
  },
});

/**
 * purpose: Reject a change that would leave the household without a primary caregiver. Call
 *          it only when the member being demoted or removed is a primary.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<void>)
 * @raises invalid when that primary is the only one.
 */
async function assertNotLastPrimary(ctx: QueryCtx, householdId: Id<"households">): Promise<void> {
  const members = await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId))
    .collect();
  if (members.filter((m) => m.role === "primary").length <= 1) {
    throw appError("invalid", "A household needs at least one primary caregiver");
  }
}

/**
 * purpose: Change a caregiver's role. Primaries only. The household's last primary cannot
 *          be demoted (an intentional improvement over the SQL).
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Member to change.
 * @param role: (MemberRole) New role.
 * @return: (null)
 */
export const updateMemberRole = mutation({
  args: { householdId: v.id("households"), userId: v.string(), role: memberRole },
  handler: async (ctx, args): Promise<null> => {
    await requirePrimary(ctx, args.householdId);
    const member = await findMember(ctx, args.householdId, args.userId);
    if (!member) throw appError("not_found", "Member not found");
    if (member.role === "primary" && args.role !== "primary") {
      await assertNotLastPrimary(ctx, args.householdId);
    }
    await ctx.db.patch(member._id, { role: args.role });
    return null;
  },
});

/**
 * purpose: Remove a caregiver. A primary may remove anyone; any member may remove themselves.
 *          If the removed member was on call the household has no on-call contact (the SQL
 *          foreign key's `on delete set null`). The last primary cannot be removed.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) Member to remove.
 * @return: (null)
 */
export const removeMember = mutation({
  args: { householdId: v.id("households"), userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const callerId = await requireUserId(ctx);
    if (callerId === args.userId) {
      await requireReader(ctx, args.householdId);
    } else {
      await requirePrimary(ctx, args.householdId);
    }
    const member = await findMember(ctx, args.householdId, args.userId);
    if (!member) throw appError("not_found", "Member not found");
    if (member.role === "primary") await assertNotLastPrimary(ctx, args.householdId);
    await ctx.db.delete(member._id);

    const household = await ctx.db.get(args.householdId);
    if (household && household.onCallUserId === args.userId) {
      await ctx.db.patch(args.householdId, { onCallUserId: undefined });
    }
    return null;
  },
});

/**
 * purpose: Generate a one-time code (valid 24 hours) to pair a device or invite a caregiver.
 *          Editors only; only primaries may invite another primary.
 * @param householdId: (Id<"households">) Household.
 * @param grants: (JoinGrant) What the code grants.
 * @return: ({code, grants, expiresAt}) The new code.
 */
export const createJoinCode = mutation({
  args: { householdId: v.id("households"), grants: joinGrant },
  handler: async (ctx, args): Promise<{ code: string; grants: JoinGrant; expiresAt: number }> => {
    const actor =
      args.grants === "caregiver_primary"
        ? await requirePrimary(ctx, args.householdId)
        : await requireEditor(ctx, args.householdId);
    const expiresAt = Date.now() + CODE_TTL_MS;
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const code = randomCode();
      if (await findJoinCode(ctx, code)) continue;
      await ctx.db.insert("joinCodes", {
        code,
        householdId: args.householdId,
        grants: args.grants,
        createdBy: actor.userId,
        expiresAt,
      });
      return { code, grants: args.grants, expiresAt };
    }
    throw appError("limit", "Could not generate a unique join code");
  },
});

/**
 * purpose: The household's open join codes: unredeemed and unexpired (filtered in memory
 *          after the by_household index). Editors only.
 * @param householdId: (Id<"households">) Household.
 * @return: (Doc<"joinCodes">[]) Open codes.
 */
export const listJoinCodes = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<Doc<"joinCodes">[]> => {
    await requireEditor(ctx, args.householdId);
    const now = Date.now();
    const rows = await ctx.db
      .query("joinCodes")
      .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
      .collect();
    return rows.filter((row) => row.redeemedAt === undefined && row.expiresAt > now);
  },
});

/**
 * purpose: Delete a join code (for example to revoke an unused invite). Editors only.
 * @param householdId: (Id<"households">) Household that owns the code.
 * @param code: (string) The code.
 * @return: (null)
 */
export const deleteJoinCode = mutation({
  args: { householdId: v.id("households"), code: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await requireEditor(ctx, args.householdId);
    const row = await findJoinCode(ctx, args.code);
    if (!row || row.householdId !== args.householdId) {
      throw appError("not_found", "Join code not found");
    }
    await ctx.db.delete(row._id);
    return null;
  },
});

/**
 * purpose: Join a household as a caregiver using an invite code. Device codes are redeemed
 *          by pairDevice instead.
 * @param code: (string) The code; trimmed and case-insensitive.
 * @param displayName: (string, optional) Display name; defaults to "Caregiver".
 * @return: (Id<"households">) The joined household.
 */
export const redeemJoinCode = mutation({
  args: { code: v.string(), displayName: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Id<"households">> => {
    const userId = await requireCaregiverAccount(ctx);
    const now = Date.now();
    const row = await loadRedeemableCode(ctx, args.code, now);
    if (isDeviceGrant(row.grants)) throw invalidCodeError();
    if (await findMember(ctx, row.householdId, userId)) {
      throw appError("invalid", "You are already a member of this household");
    }
    await ctx.db.insert("householdMembers", {
      householdId: row.householdId,
      userId,
      role: row.grants.replace("caregiver_", "") as MemberRole,
      displayName: args.displayName?.trim() || DEFAULT_CAREGIVER_NAME,
    });
    await ctx.db.patch(row._id, { redeemedBy: userId, redeemedAt: now });
    return row.householdId;
  },
});

/**
 * purpose: Pair a device using a device code. Internal: the /pair HTTP action calls it after
 *          creating the device's Clerk user.
 * @param code: (string) The code; trimmed and case-insensitive.
 * @param userId: (string) Clerk user id created for the device.
 * @param name: (string, optional) Device name.
 * @return: ({householdId, deviceId, kind}) The pairing.
 */
export const pairDevice = internalMutation({
  args: { code: v.string(), userId: v.string(), name: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ householdId: Id<"households">; deviceId: Id<"devices">; kind: DeviceKind }> => {
    const now = Date.now();
    const row = await loadRedeemableCode(ctx, args.code, now);
    if (!isDeviceGrant(row.grants)) throw invalidCodeError();
    if (await findDevice(ctx, args.userId)) {
      throw appError("invalid", "This user is already a paired device");
    }
    const existingMember = await ctx.db
      .query("householdMembers")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (existingMember) throw appError("invalid", "This user is already a caregiver");

    const deviceId = await ctx.db.insert("devices", {
      householdId: row.householdId,
      userId: args.userId,
      kind: row.grants,
      name: args.name,
    });
    await ctx.db.patch(row._id, { redeemedBy: args.userId, redeemedAt: now });
    return { householdId: row.householdId, deviceId, kind: row.grants };
  },
});

/**
 * purpose: The household's paired devices.
 * @param householdId: (Id<"households">) Household.
 * @return: (Doc<"devices">[]) Devices. Readers only.
 */
export const listDevices = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<Doc<"devices">[]> => {
    await requireReader(ctx, args.householdId);
    return await ctx.db
      .query("devices")
      .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
      .collect();
  },
});

/**
 * purpose: Unpair a device. Editors only. (Phase 2 also deletes the device's Clerk user.)
 * @param householdId: (Id<"households">) Household.
 * @param deviceId: (Id<"devices">) Device to remove.
 * @return: (null)
 */
export const removeDevice = mutation({
  args: { householdId: v.id("households"), deviceId: v.id("devices") },
  handler: async (ctx, args): Promise<null> => {
    await requireEditor(ctx, args.householdId);
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.householdId !== args.householdId) {
      throw appError("not_found", "Device not found");
    }
    await ctx.db.delete(device._id);
    return null;
  },
});

/**
 * purpose: Register a push token for the signed-in user. Re-registering one's own token is a
 *          no-op; a token already registered to another user is rejected, never taken over.
 * @param token: (string) Push token.
 * @return: (null)
 * @raises forbidden when the token belongs to another account.
 */
export const registerPushToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireUserId(ctx);
    const token = requireNonBlank(args.token, "Token");
    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    // The app unregisters its token on sign-out, so a live foreign token is not ours to take.
    if (!existing) {
      await ctx.db.insert("pushTokens", { userId, token });
    } else if (existing.userId !== userId) {
      throw appError("forbidden", "This push token belongs to another account");
    }
    return null;
  },
});

/**
 * purpose: Remove one of the signed-in user's own push tokens.
 * @param token: (string) Push token.
 * @return: (null)
 */
export const unregisterPushToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token.trim()))
      .unique();
    if (existing && existing.userId === userId) await ctx.db.delete(existing._id);
    return null;
  },
});
