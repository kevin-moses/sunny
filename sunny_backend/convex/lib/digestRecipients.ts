import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { actorUserId, requireCaregiverMember } from "./access";
import type { Actor } from "./access";
import { audit } from "./audit";
import { appError } from "./errors";

export function receivesDigest(member: Pick<Doc<"householdMembers">, "digestOptOut">): boolean {
  return member.digestOptOut !== true;
}

export async function setDigestDelivery(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
  receives: boolean,
): Promise<Doc<"householdMembers">> {
  const userId = actorUserId(actor);
  if (userId === undefined) throw appError("forbidden", "Only a caregiver can do this");
  const member = await requireCaregiverMember(ctx, householdId, userId);
  if (receivesDigest(member) === receives) return member;
  const digestOptOut = receives ? undefined : true;
  await ctx.db.patch(member._id, { digestOptOut });
  await audit(ctx, {
    householdId: member.householdId,
    actor,
    action: "digest_delivery",
    entity: "householdMember",
    entityId: member._id,
    detail: { userId: member.userId, receives },
  });
  return { ...member, digestOptOut };
}
