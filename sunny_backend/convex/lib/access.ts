// lib/access.ts
// Purpose: Access control, replacing Postgres row level security. The caller is resolved
// from the Clerk identity (the subject is the user id) to an Actor: a caregiver with a role
// in one household, or a paired senior device bound to one household. Backend callers
// ("agent", "system") are only ever constructed by internal code, never from auth. Every
// public query and mutation calls one of the require* helpers before touching data.
//
// Device identities never act as caregivers. Device Clerk users carry the custom JWT claim
// `sunny_kind: "device"`: the /pair action sets Clerk public_metadata.sunny_kind = "device"
// and the Clerk JWT template named "convex" maps it into the token. The caregiver paths
// reject that claim as well as a devices row, so an unpaired device (row deleted, token
// still valid) or a device user that exists before pairDevice runs cannot become a caregiver.
// requireSenior stays keyed on the devices row.
//
// Last modified: 2026-10-28

import type { Doc, Id } from "../_generated/dataModel";
import type { UserIdentity } from "convex/server";
import type { QueryCtx } from "../_generated/server";
import { appError } from "./errors";

/** A signed-in caregiver acting within one household. */
export interface CaregiverActor {
  kind: "caregiver";
  userId: string;
  householdId: Id<"households">;
  role: Doc<"householdMembers">["role"];
  member: Doc<"householdMembers">;
}

/** A paired senior device acting within its household. */
export interface DeviceActor {
  kind: "senior_device";
  userId: string;
  householdId: Id<"households">;
  device: Doc<"devices">;
}

/** Everyone who can be the actor of a change; agent and system are backend only. */
export type Actor = CaregiverActor | DeviceActor | { kind: "agent" } | { kind: "system" };

/**
 * purpose: The user id behind an actor, for audit and ownership columns.
 * @param actor: (Actor) The actor.
 * @return: (string | undefined) The Clerk user id; undefined for agent and system actors.
 */
export function actorUserId(actor: Actor): string | undefined {
  return "userId" in actor ? actor.userId : undefined;
}

/**
 * purpose: Load a household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"households">>) The household.
 * @raises not_found when it does not exist.
 */
export async function loadHousehold(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"households">> {
  const household = await ctx.db.get(householdId);
  if (!household) throw appError("not_found", "Household not found");
  return household;
}

/**
 * purpose: The signed-in user's id (the Clerk subject), if any.
 * @param ctx: (QueryCtx) Query or mutation context.
 * @return: (string | null) User id, or null when signed out.
 */
export async function currentUserId(ctx: QueryCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? identity.subject : null;
}

/**
 * purpose: Whether a token identity carries the device claim `sunny_kind: "device"`.
 * @param identity: (UserIdentity | null) Identity from ctx.auth, or null when signed out.
 * @return: (boolean) True for a device Clerk user, whether or not it is currently paired.
 */
export function isDeviceIdentity(identity: UserIdentity | null): boolean {
  return identity !== null && identity["sunny_kind"] === "device";
}

/**
 * purpose: The signed-in user's id, or an "unauthenticated" error.
 * @param ctx: (QueryCtx) Query or mutation context.
 * @return: (string) User id.
 */
export async function requireUserId(ctx: QueryCtx): Promise<string> {
  const userId = await currentUserId(ctx);
  if (userId === null) throw appError("unauthenticated", "Sign in first");
  return userId;
}

/**
 * purpose: A user's membership row in a household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param userId: (string) User id.
 * @return: (Doc<"householdMembers"> | null) The member, or null.
 */
export async function findMember(
  ctx: QueryCtx,
  householdId: Id<"households">,
  userId: string,
): Promise<Doc<"householdMembers"> | null> {
  return await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId).eq("userId", userId))
    .unique();
}

/**
 * purpose: The paired device row for a user, if the user is a senior device.
 * @param ctx: (QueryCtx) Context.
 * @param userId: (string) User id.
 * @return: (Doc<"devices"> | null) The device, or null.
 */
export async function findDevice(ctx: QueryCtx, userId: string): Promise<Doc<"devices"> | null> {
  return await ctx.db
    .query("devices")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/**
 * purpose: Resolve the caller to a caregiver of the household, optionally restricted to roles.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param roles: (readonly string[] | null) Allowed roles, or null for any role.
 * @return: (CaregiverActor) The caregiver actor.
 */
async function requireCaregiver(
  ctx: QueryCtx,
  householdId: Id<"households">,
  roles: readonly Doc<"householdMembers">["role"][] | null,
): Promise<CaregiverActor> {
  const userId = await requireUserId(ctx);
  if (isDeviceIdentity(await ctx.auth.getUserIdentity())) {
    throw appError("forbidden", "Not allowed");
  }
  const member = await findMember(ctx, householdId, userId);
  if (!member || (roles !== null && !roles.includes(member.role))) {
    throw appError("forbidden", "Not allowed");
  }
  return { kind: "caregiver", userId, householdId, role: member.role, member };
}

/**
 * purpose: Require read access: a caregiver of any role, or a device paired to the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (CaregiverActor | DeviceActor) The resolved actor.
 */
export async function requireReader(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<CaregiverActor | DeviceActor> {
  const userId = await requireUserId(ctx);
  const member = isDeviceIdentity(await ctx.auth.getUserIdentity())
    ? null
    : await findMember(ctx, householdId, userId);
  if (member) return { kind: "caregiver", userId, householdId, role: member.role, member };
  const device = await findDevice(ctx, userId);
  if (device && device.householdId === householdId) {
    return { kind: "senior_device", userId, householdId, device };
  }
  throw appError("forbidden", "Not allowed");
}

/**
 * purpose: Require edit access: a primary or member caregiver (viewers are read only).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (CaregiverActor) The caregiver actor.
 */
export async function requireEditor(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<CaregiverActor> {
  return await requireCaregiver(ctx, householdId, ["primary", "member"]);
}

/**
 * purpose: Require a primary caregiver of the household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (CaregiverActor) The caregiver actor.
 */
export async function requirePrimary(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<CaregiverActor> {
  return await requireCaregiver(ctx, householdId, ["primary"]);
}

/**
 * purpose: Require the caller to act for the senior: a device paired to this household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (DeviceActor) The device actor.
 */
export async function requireSenior(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<DeviceActor> {
  const userId = await requireUserId(ctx);
  const device = await findDevice(ctx, userId);
  if (!device || device.householdId !== householdId) {
    throw appError("forbidden", "Only the senior's devices can do this");
  }
  return { kind: "senior_device", userId, householdId, device };
}

/**
 * purpose: Require a signed-in caregiver account, i.e. a user who is not a device: neither
 *          carrying the device claim nor having a devices row.
 * @param ctx: (QueryCtx) Context.
 * @return: (string) The caregiver's user id.
 */
export async function requireCaregiverAccount(ctx: QueryCtx): Promise<string> {
  const userId = await requireUserId(ctx);
  if (isDeviceIdentity(await ctx.auth.getUserIdentity()) || (await findDevice(ctx, userId))) {
    throw appError("forbidden", "Only a signed-in caregiver can do this");
  }
  return userId;
}

/**
 * purpose: Households the signed-in user can see, as a caregiver or as a paired device.
 * @param ctx: (QueryCtx) Context.
 * @return: (Id<"households">[]) Distinct household ids; empty when signed out.
 */
export async function myHouseholdIds(ctx: QueryCtx): Promise<Id<"households">[]> {
  const userId = await currentUserId(ctx);
  if (userId === null) return [];
  const members = await ctx.db
    .query("householdMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const device = await findDevice(ctx, userId);
  const ids = new Set<Id<"households">>(members.map((m) => m.householdId));
  if (device) ids.add(device.householdId);
  return [...ids];
}
