import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import {
  ALREADY_IN_HOUSEHOLD,
  findDevice,
  findMember,
  hasMembership,
  insertMembership,
  isDeviceAccount,
  loadHousehold,
  myHouseholdIds,
  requireCaregiverAccount,
  requireEditor,
  requirePrimary,
  requireReader,
  requireUserId,
} from "./lib/access";
import { audit } from "./lib/audit";
import { dropMemberConnections } from "./lib/calendarSync";
import { appError } from "./lib/errors";
import { seedDefaultPolicies } from "./lib/policies";
import {
  householdSettingsFields,
  requireTimezone,
  updateHouseholdCore,
} from "./lib/householdSettings";
import { isValidDeviceToken } from "./lib/apnsPayload";
import { requireNonBlank } from "./lib/text";
import { joinGrant, memberRole } from "./lib/validators";
import type { DeviceKind, JoinGrant, MemberRole } from "./lib/validators";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ATTEMPTS = 10;
const DEFAULT_CAREGIVER_NAME = "Caregiver";
export const PAIRING_RETRY_WINDOW_MS = 10 * 60 * 1000;

export type MemberView = Omit<
  Doc<"householdMembers">,
  "phone" | "phoneVerifiedAt" | "pendingPhone"
> &
  Partial<Pick<Doc<"householdMembers">, "phone" | "phoneVerifiedAt" | "pendingPhone">> & {
    phoneVerified: boolean;
  };

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

async function findJoinCode(ctx: QueryCtx, code: string): Promise<Doc<"joinCodes"> | null> {
  return await ctx.db
    .query("joinCodes")
    .withIndex("by_code", (q) => q.eq("code", code.trim().toUpperCase()))
    .unique();
}

async function loadRedeemableCode(
  ctx: QueryCtx,
  rawCode: string,
  now: number,
): Promise<Doc<"joinCodes">> {
  const row = await findJoinCode(ctx, rawCode);
  if (!row || row.redeemedAt !== undefined || row.expiresAt <= now) throw invalidCodeError();
  return row;
}

function invalidCodeError(): Error {
  return appError("not_found", "This code is invalid or has expired");
}

function isDeviceGrant(grant: JoinGrant): grant is DeviceKind {
  return grant === "senior_phone" || grant === "home_display";
}

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
    if (await hasMembership(ctx, userId)) throw appError("invalid", ALREADY_IN_HOUSEHOLD);

    const householdId = await ctx.db.insert("households", {
      seniorPreferredName,
      timezone,
      digestTime: "19:00",
      eventNoticeTime: "08:00",
      shareTranscripts: false,
      backgroundPaused: false,
    });
    await insertMembership(ctx, { householdId, userId, role: "primary", displayName });
    await seedDefaultPolicies(ctx, householdId);
    return householdId;
  },
});

type AccountKind = "device" | "caregiver";

export const mine = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    accountKind: AccountKind | null;
    households: Array<{
      household: Doc<"households">;
      role: MemberRole | null;
      deviceKind: DeviceKind | null;
    }>;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return { accountKind: null, households: [] };
    const userId = identity.subject;
    const device = await findDevice(ctx, userId);
    const ids = await myHouseholdIds(ctx);
    const households = [];
    for (const id of ids) {
      const household = await ctx.db.get(id);
      if (!household) continue;
      const member = await findMember(ctx, id, userId);
      households.push({
        household,
        role: member ? member.role : null,
        deviceKind: !member && device && device.householdId === id ? device.kind : null,
      });
    }
    return {
      accountKind: isDeviceAccount(identity, device) ? "device" : "caregiver",
      households,
    };
  },
});

export const get = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<Doc<"households">> => {
    await requireReader(ctx, args.householdId);
    return await loadHousehold(ctx, args.householdId);
  },
});

export const update = mutation({
  args: { householdId: v.id("households"), ...householdSettingsFields },
  handler: async (ctx, args): Promise<null> => {
    const { householdId, ...fields } = args;
    const actor = await requireEditor(ctx, householdId);
    await updateHouseholdCore(ctx, actor, householdId, fields);
    return null;
  },
});

export const listMembers = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<MemberView[]> => {
    const actor = await requireReader(ctx, args.householdId);
    const members = await ctx.db
      .query("householdMembers")
      .withIndex("by_household_user", (q) => q.eq("householdId", args.householdId))
      .collect();
    return members.map((m) => {
      const { phone, phoneVerifiedAt, pendingPhone, ...rest } = m;
      const view: MemberView = { ...rest, phoneVerified: phone !== undefined && !!phoneVerifiedAt };
      if (actor.kind === "caregiver") Object.assign(view, { phone, phoneVerifiedAt, pendingPhone });
      return view;
    });
  },
});

export { clearMyPhone, confirmMyPhone, myPhoneStatus, setMyPhone } from "./phone";

async function assertNotLastPrimary(ctx: QueryCtx, householdId: Id<"households">): Promise<void> {
  const members = await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId))
    .collect();
  if (members.filter((m) => m.role === "primary").length <= 1) {
    throw appError("invalid", "A household needs at least one primary caregiver");
  }
}

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
    await dropMemberConnections(ctx, args.householdId, args.userId);
    return null;
  },
});

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

export const redeemJoinCode = mutation({
  args: { code: v.string(), displayName: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Id<"households">> => {
    const userId = await requireCaregiverAccount(ctx);
    const now = Date.now();
    const row = await loadRedeemableCode(ctx, args.code, now);
    if (isDeviceGrant(row.grants)) {
      throw appError(
        "invalid",
        "That code is for setting up a senior's device. Ask a family member for a caregiver invite code.",
      );
    }
    if (await findMember(ctx, row.householdId, userId)) {
      throw appError("invalid", "You are already a member of this household");
    }
    await insertMembership(ctx, {
      householdId: row.householdId,
      userId,
      role: row.grants.replace("caregiver_", "") as MemberRole,
      displayName: args.displayName?.trim() || DEFAULT_CAREGIVER_NAME,
    });
    await ctx.db.patch(row._id, { redeemedBy: userId, redeemedAt: now });
    return row.householdId;
  },
});

export const checkDeviceCode = internalQuery({
  args: { code: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const row = await loadRedeemableCode(ctx, args.code, Date.now());
    if (!isDeviceGrant(row.grants)) throw invalidCodeError();
    return null;
  },
});

export const pairDevice = internalMutation({
  args: {
    code: v.string(),
    userId: v.string(),
    name: v.optional(v.string()),
    pairingNonce: v.optional(v.string()),
  },
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
    if (await hasMembership(ctx, args.userId))
      throw appError("invalid", "This user is already a caregiver");

    const deviceId = await ctx.db.insert("devices", {
      householdId: row.householdId,
      userId: args.userId,
      kind: row.grants,
      name: args.name,
      pairedAt: now,
      pairingNonce: args.pairingNonce,
    });
    await ctx.db.patch(row._id, { redeemedBy: args.userId, redeemedAt: now });
    return { householdId: row.householdId, deviceId, kind: row.grants };
  },
});

export const findRecentPairing = internalQuery({
  args: { code: v.string(), pairingNonce: v.string(), now: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    userId: string;
    householdId: Id<"households">;
    deviceId: Id<"devices">;
    kind: DeviceKind;
  } | null> => {
    const row = await ctx.db
      .query("joinCodes")
      .withIndex("by_code", (q) => q.eq("code", args.code.trim().toUpperCase()))
      .unique();
    if (!row || row.redeemedBy === undefined || !isDeviceGrant(row.grants)) return null;
    const device = await findDevice(ctx, row.redeemedBy);
    if (!device || device.pairingNonce === undefined) return null;
    if (device.pairingNonce !== args.pairingNonce) return null;
    const age = (args.now ?? Date.now()) - (device.pairedAt ?? 0);
    if (age < 0 || age > PAIRING_RETRY_WINDOW_MS) return null;
    return {
      userId: device.userId,
      householdId: device.householdId,
      deviceId: device._id,
      kind: row.grants,
    };
  },
});

export type DeviceView = Omit<Doc<"devices">, "pairingNonce" | "tokenHash">;

export const listDevices = query({
  args: { householdId: v.id("households") },
  handler: async (ctx, args): Promise<DeviceView[]> => {
    await requireReader(ctx, args.householdId);
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_household", (q) => q.eq("householdId", args.householdId))
      .collect();
    return rows.map(({ pairingNonce: _nonce, tokenHash: _hash, ...device }) => device);
  },
});

export const removeDevice = mutation({
  args: { householdId: v.id("households"), deviceId: v.id("devices") },
  handler: async (ctx, args): Promise<null> => {
    await requireEditor(ctx, args.householdId);
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.householdId !== args.householdId) {
      throw appError("not_found", "Device not found");
    }
    await ctx.db.delete(device._id);
    const tokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userId", device.userId))
      .collect();
    for (const token of tokens) await ctx.db.delete(token._id);
    await ctx.scheduler.runAfter(0, internal.pairing.deleteClerkUser, { userId: device.userId });
    return null;
  },
});

export const revokeDeviceToken = mutation({
  args: { householdId: v.id("households"), deviceId: v.id("devices") },
  handler: async (ctx, args): Promise<null> => {
    const actor = await requireEditor(ctx, args.householdId);
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.householdId !== args.householdId) {
      throw appError("not_found", "Device not found");
    }
    await ctx.db.patch(device._id, { tokenHash: undefined, tokenIssuedAt: undefined });
    await audit(ctx, {
      householdId: args.householdId,
      actor,
      action: "revoke_device_token",
      entity: "device",
      entityId: device._id,
      detail: { hadToken: device.tokenHash !== undefined },
    });
    return null;
  },
});

async function isOrphanedUser(ctx: QueryCtx, userId: string): Promise<boolean> {
  if (await findDevice(ctx, userId)) return false;
  return !(await hasMembership(ctx, userId));
}

async function mayTakeOverToken(
  ctx: QueryCtx,
  ownerId: string,
  callerId: string,
): Promise<boolean> {
  if (await isOrphanedUser(ctx, ownerId)) return true;
  if (await findDevice(ctx, ownerId)) return false;
  const identity = await ctx.auth.getUserIdentity();
  return !isDeviceAccount(identity, await findDevice(ctx, callerId));
}

export const registerPushToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireUserId(ctx);
    const token = requireNonBlank(args.token, "Token");
    if (!isValidDeviceToken(token)) throw appError("invalid", "That is not a valid push token");
    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!existing) {
      await ctx.db.insert("pushTokens", { userId, token });
    } else if (existing.userId !== userId) {
      if (!(await mayTakeOverToken(ctx, existing.userId, userId))) {
        throw appError("forbidden", "This push token belongs to another account");
      }
      await ctx.db.patch(existing._id, { userId });
    }
    return null;
  },
});

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
