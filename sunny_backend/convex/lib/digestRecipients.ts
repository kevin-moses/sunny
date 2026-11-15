// lib/digestRecipients.ts
// Purpose: Who receives the daily digest by push or text, and the one place it is changed.
// Every caregiver of the household receives it unless their householdMembers row has
// digestOptOut set (receivesDigest); digest.complete still posts the digest in the chat thread
// for everyone, opted out or not, and only skips their push and text.
//
// Who may change it: a provisional rule (2026-11-14), not yet confirmed by the product owner,
// kept in this one place so changing it is one edit: a caregiver changes only their own digest
// delivery. The only caller is the household agent's set_digest_delivery tool
// (lib/agentSetupTools.ts), which takes no name: setDigestDelivery changes the acting
// caregiver's own row (actorUserId); the runtime has already checked that
// the requester is an editor (agentRuntime.executeToolCalls). The change is audited
// (digest_delivery) under that caregiver. A viewer cannot chat, so a viewer cannot opt out
// until the settings screen exists.
//
// Last modified: 2026-11-14

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { actorUserId, requireCaregiverMember } from "./access";
import type { Actor } from "./access";
import { audit } from "./audit";
import { appError } from "./errors";

/**
 * purpose: Whether a caregiver receives the daily digest by push or text.
 * @param member: (Pick<Doc<"householdMembers">, "digestOptOut">) The caregiver.
 * @return: (boolean) False only when they turned it off.
 */
export function receivesDigest(member: Pick<Doc<"householdMembers">, "digestOptOut">): boolean {
  return member.digestOptOut !== true;
}

/**
 * purpose: Turn the daily digest's push and text on or off for the acting caregiver (the
 *          header's rule: only their own; for the household agent, the caregiver it acts for).
 *          Setting it to what it already is writes nothing.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) The editor caregiver, or the household agent acting for one.
 * @param householdId: (Id<"households">) The household the actor acts in.
 * @param receives: (boolean) True to receive it, false to stop it.
 * @return: (Promise<Doc<"householdMembers">>) The caregiver after the change.
 * @raises forbidden when the actor has no caregiver behind it (the system, the voice agent)
 *         or is not a caregiver of the household.
 */
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
