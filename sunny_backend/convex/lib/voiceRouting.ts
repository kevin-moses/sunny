// lib/voiceRouting.ts
// Purpose: The two ways the voice agent reaches family on the senior's behalf, shared by the
// agent:* functions (agent.ts): flagging a caregiver (notes/SPEC.md "Route to a person": past a
// medication limit, new or repeated symptoms, money requests or anything scam-like, signs of
// distress, or the senior asking for family) and sending a family message the senior dictated
// ("Tell Sarah I'm home"). Both queue through the notification outbox (insertNotification, so
// delivery, retries and the send-time checks are the usual ones) and write an audit row.
//
// Recipients: a flag goes to the on-call caregiver, or to every caregiver when no on-call
// caregiver is set (or they left). A family message goes to the caregivers whose display name
// matches the name the senior used (whole name or first name, case-insensitive), or to every
// caregiver when nobody matches. familyMessages has no recipient field, so when the senior
// named someone the stored body itself starts "For <name>:" ("For Sarah: I'm home"), and the
// notification carries the same text; the audit row's detail also keeps the name.
//
// Repeats: a flag with the same reason as one queued in the last 10 minutes is not sent again
// (status already_flagged), so a model that calls the tool twice does not double-text family.
//
// Last modified: 2026-11-09

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Actor } from "./access";
import { audit } from "./audit";
import { insertNotification } from "./delivery";
import { appError } from "./errors";
import { singleLine } from "./memoryLimits";

/** Why the voice agent flagged a caregiver. */
export const flagReason = v.union(
  v.literal("medication_limit"),
  v.literal("symptom"),
  v.literal("money_request"),
  v.literal("scam"),
  v.literal("distress"),
  v.literal("help_requested"),
);
/** Type of flagReason. */
export type FlagReason = Infer<typeof flagReason>;

/** The voice agent as an actor (no caregiver behind it). */
export const VOICE_AGENT: Actor = { kind: "agent" };

/** A flag with the same reason within this window (ms) is not sent again. */
export const FLAG_REPEAT_WINDOW_MS = 10 * 60 * 1000;
/** Outbox rows scanned for a recent flag. */
const RECENT_FLAG_SCAN = 100;
/** Longest flag detail and family message sent; longer text is cut, not rejected. */
const MAX_FLAG_DETAIL_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 1000;
/** Longest recipient name kept in "For <name>:". */
const MAX_NAME_LENGTH = 60;

/** Notification title per reason, given the senior's preferred name. */
const FLAG_TITLES: Record<FlagReason, (name: string) => string> = {
  medication_limit: (name) => `${name} went past a medication limit`,
  symptom: (name) => `${name} mentioned a symptom`,
  money_request: (name) => `${name} was asked for money`,
  scam: (name) => `${name} may be facing a scam`,
  distress: (name) => `${name} sounded distressed`,
  help_requested: (name) => `${name} asked for you`,
};

/** What flagCaregiverCore did. */
export interface FlagResult {
  status: "flagged" | "already_flagged";
  /** Display names of the caregivers the flag went to (or went to earlier). */
  notified: string[];
}

/** What sendFamilyMessageCore did. */
export interface FamilyMessageResult {
  /** sent: to the named caregiver(s) or, with no name, to everyone; sent_to_family: the name
   * matched no caregiver, so everyone got it. */
  status: "sent" | "sent_to_family";
  messageId: Id<"familyMessages">;
  recipients: string[];
}

/**
 * purpose: The household's caregivers.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"householdMembers">[]>) Every member row.
 */
export async function householdCaregivers(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"householdMembers">[]> {
  return await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", householdId))
    .collect();
}

/**
 * purpose: Who a flag goes to: the on-call caregiver when set and still a member, else everyone.
 * @param members: (Doc<"householdMembers">[]) The household's caregivers.
 * @param household: (Doc<"households">) The household.
 * @return: (Doc<"householdMembers">[]) The recipients.
 */
export function flagRecipients(
  members: Doc<"householdMembers">[],
  household: Doc<"households">,
): Doc<"householdMembers">[] {
  const onCall = members.find((m) => m.userId === household.onCallUserId);
  return onCall ? [onCall] : members;
}

/**
 * purpose: The caregivers a spoken name refers to: whole display name or first name, ignoring
 *          case.
 * @param members: (Doc<"householdMembers">[]) The household's caregivers.
 * @param name: (string) The name the senior used, e.g. "Sarah".
 * @return: (Doc<"householdMembers">[]) Matching members; empty for a blank name or no match.
 */
export function membersNamed(
  members: Doc<"householdMembers">[],
  name: string,
): Doc<"householdMembers">[] {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return [];
  const wantedFirst = wanted.split(/\s+/)[0];
  return members.filter((m) => {
    const full = m.displayName.trim().toLowerCase();
    return full === wanted || full.split(/\s+/)[0] === wantedFirst;
  });
}

/**
 * purpose: The flags with this reason queued within the repeat window.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param reason: (FlagReason) The reason.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Doc<"notificationOutbox">[]>) The recent rows with this reason.
 */
async function recentFlags(
  ctx: QueryCtx,
  householdId: Id<"households">,
  reason: FlagReason,
  now: number,
): Promise<Doc<"notificationOutbox">[]> {
  const rows = await ctx.db
    .query("notificationOutbox")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .order("desc")
    .take(RECENT_FLAG_SCAN);
  return rows.filter(
    (r) =>
      r.kind === "agent_flag" &&
      r.payload.reason === reason &&
      typeof r.payload.flaggedAt === "number" &&
      r.payload.flaggedAt >= now - FLAG_REPEAT_WINDOW_MS,
  );
}

/**
 * purpose: Ask a caregiver to look in: queue an agent_flag notification to the on-call
 *          caregiver (or everyone) and audit it, unless the same reason was flagged in the last
 *          10 minutes.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, reason, detail, conversationId, now}) The household, why, a short
 *        description for the caregiver (cut to 300 characters; blank sends the title only), the
 *        conversation it came from, and the clock.
 * @return: (Promise<FlagResult>) flagged or already_flagged, with the caregivers' names.
 */
export async function flagCaregiverCore(
  ctx: MutationCtx,
  args: {
    household: Doc<"households">;
    reason: FlagReason;
    detail: string;
    conversationId?: Id<"conversations">;
    now: number;
  },
): Promise<FlagResult> {
  const { household, reason, now } = args;
  const members = await householdCaregivers(ctx, household._id);
  const names = new Map(members.map((m) => [m.userId, m.displayName]));
  const earlier = await recentFlags(ctx, household._id, reason, now);
  if (earlier.length > 0) {
    const notified = earlier.map((r) => names.get(r.recipientUserId ?? "") ?? "family");
    return { status: "already_flagged", notified: [...new Set(notified)] };
  }
  const recipients = flagRecipients(members, household);
  const detail = args.detail.trim().slice(0, MAX_FLAG_DETAIL_LENGTH);
  for (const member of recipients) {
    await insertNotification(ctx, {
      householdId: household._id,
      kind: "agent_flag",
      title: FLAG_TITLES[reason](household.seniorPreferredName),
      body: detail,
      payload: { reason, flaggedAt: now, conversationId: args.conversationId ?? null },
      recipientUserId: member.userId,
    });
  }
  await audit(ctx, {
    householdId: household._id,
    actor: VOICE_AGENT,
    action: "flag_caregiver",
    entity: "household",
    entityId: household._id,
    detail: {
      reason,
      detail,
      conversationId: args.conversationId ?? null,
      recipients: recipients.map((m) => m.userId),
    },
  });
  return { status: "flagged", notified: recipients.map((m) => m.displayName) };
}

/**
 * purpose: Send a message the senior dictated to family: store it as a familyMessages row from
 *          the senior (body "For <name>: <message>" when a name was given), queue a
 *          family_message notification with the same text to the named caregiver (or
 *          everyone) and audit it with the intended recipient.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, to, body, conversationId}) The household, the name the senior used
 *        (blank for "my family"; one line, at most 60 characters), the message (trimmed; the
 *        stored body is cut to 1000 characters) and the conversation it came from.
 * @return: (Promise<FamilyMessageResult>) The status, the message id and the recipients' names.
 * @raises invalid when the message is blank.
 */
export async function sendFamilyMessageCore(
  ctx: MutationCtx,
  args: {
    household: Doc<"households">;
    to: string;
    body: string;
    conversationId?: Id<"conversations">;
  },
): Promise<FamilyMessageResult> {
  const { household } = args;
  const words = args.body.trim();
  if (words === "") throw appError("invalid", "The message is empty");
  const to = singleLine(args.to).slice(0, MAX_NAME_LENGTH);
  const body = (to === "" ? words : `For ${to}: ${words}`).slice(0, MAX_MESSAGE_LENGTH);
  const members = await householdCaregivers(ctx, household._id);
  const named = membersNamed(members, to);
  const recipients = named.length > 0 ? named : members;
  const unmatched = to !== "" && named.length === 0;
  const messageId = await ctx.db.insert("familyMessages", {
    householdId: household._id,
    senderKind: "senior",
    body,
  });
  for (const member of recipients) {
    await insertNotification(ctx, {
      householdId: household._id,
      kind: "family_message",
      title: `Message from ${household.seniorPreferredName}`,
      body,
      payload: { messageId },
      recipientUserId: member.userId,
    });
  }
  await audit(ctx, {
    householdId: household._id,
    actor: VOICE_AGENT,
    action: "send",
    entity: "familyMessage",
    entityId: messageId,
    detail: {
      to: to === "" ? null : to,
      conversationId: args.conversationId ?? null,
      recipients: recipients.map((m) => m.userId),
    },
  });
  return {
    status: unmatched ? "sent_to_family" : "sent",
    messageId,
    recipients: recipients.map((m) => m.displayName),
  };
}
