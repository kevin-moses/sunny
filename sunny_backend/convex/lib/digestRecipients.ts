// lib/digestRecipients.ts
// Purpose: Who receives the daily digest by push or text, and the one place it is changed.
// Every caregiver of the household receives it unless their householdMembers row has
// digestOptOut set (receivesDigest); digest.complete still posts the digest in the chat thread
// for everyone, opted out or not, and only skips their push and text.
//
// Who may change it (the product owner's rule as of 2026-11-14, kept here so a change of rule
// is one edit): any editor of the household may turn the digest on or off for any caregiver of
// that household, themselves or someone else, viewers included. Today the only caller is the
// household agent's set_digest_delivery tool (lib/agentSetupTools.ts), whose runtime has already
// checked that the requesting caregiver is an editor (agentRuntime.executeToolCalls); the change
// is audited (digest_delivery) under that caregiver.
//
// Last modified: 2026-11-14

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./access";
import { audit } from "./audit";

/**
 * purpose: Whether a caregiver receives the daily digest by push or text.
 * @param member: (Pick<Doc<"householdMembers">, "digestOptOut">) The caregiver.
 * @return: (boolean) False only when they turned it off.
 */
export function receivesDigest(member: Pick<Doc<"householdMembers">, "digestOptOut">): boolean {
  return member.digestOptOut !== true;
}

/**
 * purpose: Turn the daily digest's push and text on or off for one caregiver (see the header for
 *          who may). Setting it to what it already is writes nothing.
 * @param ctx: (MutationCtx) Context.
 * @param actor: (Actor) The editor caregiver, or the household agent acting for one.
 * @param member: (Doc<"householdMembers">) The caregiver, a member of the household the caller
 *        acts in (the caller resolved them within it).
 * @param receives: (boolean) True to receive it, false to stop it.
 * @return: (Promise<Doc<"householdMembers">>) The caregiver after the change.
 */
export async function setDigestDelivery(
  ctx: MutationCtx,
  actor: Actor,
  member: Doc<"householdMembers">,
  receives: boolean,
): Promise<Doc<"householdMembers">> {
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
