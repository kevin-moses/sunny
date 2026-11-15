import type { Doc, Id } from "../_generated/dataModel";
import type { UserIdentity } from "convex/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { appError } from "./errors";

export interface CaregiverActor {
  kind: "caregiver";
  userId: string;
  householdId: Id<"households">;
  role: Doc<"householdMembers">["role"];
  member: Doc<"householdMembers">;
}

export interface DeviceActor {
  kind: "senior_device";
  userId: string;
  householdId: Id<"households">;
  device: Doc<"devices">;
}

export interface AgentActor {
  kind: "agent";
  onBehalfOf?: string;
  requestId?: Id<"agentRequests">;
}

export type Actor = CaregiverActor | DeviceActor | AgentActor | { kind: "system" };

export const SYSTEM_ACTOR: Actor = Object.freeze({ kind: "system" } as const);

export function actorUserId(actor: Actor): string | undefined {
  if ("userId" in actor) return actor.userId;
  return actor.kind === "agent" ? actor.onBehalfOf : undefined;
}

export async function loadHousehold(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"households">> {
  const household = await ctx.db.get(householdId);
  if (!household) throw appError("not_found", "Household not found");
  return household;
}

export async function currentUserId(ctx: QueryCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? identity.subject : null;
}

export function isDeviceIdentity(identity: UserIdentity | null): boolean {
  return identity !== null && identity["sunny_kind"] === "device";
}

export function isDeviceAccount(
  identity: UserIdentity | null,
  device: Doc<"devices"> | null,
): boolean {
  return isDeviceIdentity(identity) || device !== null;
}

export async function requireUserId(ctx: QueryCtx): Promise<string> {
  const userId = await currentUserId(ctx);
  if (userId === null) throw appError("unauthenticated", "Sign in first");
  return userId;
}

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

export const ALREADY_IN_HOUSEHOLD =
  "You already belong to a household. Ask its primary caregiver to remove you before joining another.";

export async function hasMembership(ctx: QueryCtx, userId: string): Promise<boolean> {
  const row = await ctx.db
    .query("householdMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return row !== null;
}

export async function insertMembership(
  ctx: MutationCtx,
  args: {
    householdId: Id<"households">;
    userId: string;
    role: Doc<"householdMembers">["role"];
    displayName: string;
  },
): Promise<Id<"householdMembers">> {
  if (await hasMembership(ctx, args.userId)) {
    throw appError("invalid", ALREADY_IN_HOUSEHOLD);
  }
  return await ctx.db.insert("householdMembers", args);
}

export async function householdCaregivers(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"householdMembers">[]> {
  return await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId))
    .collect();
}

export async function memberNames(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Map<string, string>> {
  const members = await householdCaregivers(ctx, householdId);
  return new Map(members.map((m) => [m.userId, m.displayName]));
}

export async function findDevice(ctx: QueryCtx, userId: string): Promise<Doc<"devices"> | null> {
  return await ctx.db
    .query("devices")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

async function requireCaregiver(
  ctx: QueryCtx,
  householdId: Id<"households">,
  roles: readonly Doc<"householdMembers">["role"][] | null,
): Promise<CaregiverActor> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw appError("unauthenticated", "Sign in first");
  const userId = identity.subject;
  const [device, member] = await Promise.all([
    findDevice(ctx, userId),
    findMember(ctx, householdId, userId),
  ]);
  if (isDeviceAccount(identity, device)) throw appError("forbidden", "Not allowed");
  if (!member || (roles !== null && !roles.includes(member.role))) {
    throw appError("forbidden", "Not allowed");
  }
  return { kind: "caregiver", userId, householdId, role: member.role, member };
}

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

export async function requireCaregiverReader(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<CaregiverActor> {
  return await requireCaregiver(ctx, householdId, null);
}

export async function requireEditor(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<CaregiverActor> {
  return await requireCaregiver(ctx, householdId, EDITOR_ROLES);
}

export const EDITOR_ROLES: readonly Doc<"householdMembers">["role"][] = ["primary", "member"];

export async function requirePrimary(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<CaregiverActor> {
  return await requireCaregiver(ctx, householdId, ["primary"]);
}

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

export async function requireCaregiverAccount(ctx: QueryCtx): Promise<string> {
  const userId = await requireUserId(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (isDeviceAccount(identity, await findDevice(ctx, userId))) {
    throw appError("forbidden", "Only a signed-in caregiver can do this");
  }
  return userId;
}

export async function requireCaregiverMember(
  ctx: QueryCtx,
  householdId: Id<"households">,
  userId: string,
): Promise<Doc<"householdMembers">> {
  const member = await findMember(ctx, householdId, userId);
  if (!member || (await findDevice(ctx, userId))) {
    throw appError("forbidden", "Only a caregiver of this household can do this");
  }
  return member;
}

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

export function verifiedPhone(
  member: Pick<Doc<"householdMembers">, "phone" | "phoneVerifiedAt">,
): string | undefined {
  return member.phoneVerifiedAt === undefined ? undefined : member.phone;
}
