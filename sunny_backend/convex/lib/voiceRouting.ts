// lib/voiceRouting.ts
// Purpose: The two ways the voice agent reaches family on the senior's behalf, shared by the
// agent:* functions (agent.ts): flagging a caregiver (notes/SPEC.md "Route to a person": past a
// medication limit, new or repeated symptoms, money requests or anything scam-like, signs of
// distress, or the senior asking for family) and sending a family message the senior dictated
// ("Tell Sarah I'm home"). Both queue through the notification outbox (insertNotification, so
// delivery, retries and the send-time checks are the usual ones) and write an audit row.
//
// Reachability: caregivers are texted, so only a member with a verified phone (lib/access
// verifiedPhone) is reachable, and only reachable members get an outbox row and are named as
// told. A flag goes to the on-call caregiver when reachable, else to every reachable caregiver.
// A family message goes to the reachable caregivers whose display name matches the name the
// senior used (whole name or first name, case-insensitive), else to every reachable caregiver.
// When nobody is reachable the status is "unreachable": the flag is still audited and the
// message still stored and audited, and the tool says family could not be reached from here.
// (Delivery may still skip a row at send time, for example a number outside the allowed
// countries; a verified phone is the best check available when the row is queued.)
//
// familyMessages has no recipient field, so when the senior named someone the stored body
// itself starts "For <name>:" ("For Sarah: I'm home"), and the notification carries the same
// text; the audit row's detail also keeps the name.
//
// Repeats and caps (every decision is an audit row with detail.status and detail.at):
// - A flag with the same key (the reason; for medication_limit the reason and the task) that was
//   delivered in the last 10 minutes (or the caller's longer window, for example a week for
//   the repeated-use flag) is not sent again (already_flagged, naming who was told).
// - At most 12 flags per household per hour reach family (rate_limited after that).
// - An identical message from the senior within 2 minutes is not sent again (already_sent).
// - At most 10 messages from the senior per household per hour (rate_limited after that; the
//   message is not stored).
//
// Flag detail (flagDetail): whatever the model or log_dose writes, a caregiver receives one
// line holding at most the first two sentences, any run of 6 or more digits (spaces or dashes
// between them allowed: card, bank and account numbers) replaced by "[number removed]", cut to
// 240 characters.
//
// Last modified: 2026-11-09

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { verifiedPhone } from "./access";
import type { Actor } from "./access";
import { audit } from "./audit";
import { insertNotification } from "./delivery";
import { appError } from "./errors";
import { singleLine } from "./memoryLimits";

/** Why the model may flag a caregiver (medication_limit is raised by log_dose only). */
export const modelFlagReason = v.union(
  v.literal("symptom"),
  v.literal("money_request"),
  v.literal("scam"),
  v.literal("distress"),
  v.literal("help_requested"),
);
/** Every reason a flag can have. */
export type FlagReason = Infer<typeof modelFlagReason> | "medication_limit";

/** The voice agent as an actor (no caregiver behind it). */
export const VOICE_AGENT: Actor = { kind: "agent" };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** A delivered flag with the same key within this window (ms) is not sent again. */
export const FLAG_REPEAT_WINDOW_MS = 10 * MINUTE_MS;
/** Flags that may reach family per household per hour. */
export const MAX_FLAGS_PER_HOUR = 12;
/** An identical senior message within this window (ms) is not sent again. */
export const MESSAGE_REPEAT_WINDOW_MS = 2 * MINUTE_MS;
/** Messages from the senior per household per hour. */
export const MAX_MESSAGES_PER_HOUR = 10;
/** Audit rows scanned (newest first) for flags of the last hour. */
const RECENT_AUDIT_SCAN = 300;
/** Audit rows scanned for a flag with a repeat window longer than an hour (repeated use). */
const LONG_AUDIT_SCAN = 2000;
/** Senior messages scanned (newest first) for repeats and the hourly cap. */
const RECENT_MESSAGE_SCAN = MAX_MESSAGES_PER_HOUR + 20;
/** Sentences of a flag detail that reach a caregiver; the rest is dropped. */
export const MAX_FLAG_SENTENCES = 2;
/** Hard cap on a flag detail after the sentence cut; longer text ends with "...". */
export const MAX_FLAG_DETAIL_LENGTH = 240;
/** Longest family message sent; longer text is cut, not rejected. */
const MAX_MESSAGE_LENGTH = 1000;
/** Longest recipient name kept in "For <name>:". */
const MAX_NAME_LENGTH = 60;
/** What a long digit run in a flag detail becomes. */
const NUMBER_REMOVED = "[number removed]";

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
  /** flagged: rows were queued for `notified`; already_flagged: an earlier flag with the same
   * key reached `notified`; unreachable: no caregiver has a verified phone; rate_limited: the
   * hourly cap was reached. */
  status: "flagged" | "already_flagged" | "unreachable" | "rate_limited";
  /** Display names of the caregivers a notification was queued for; empty otherwise. */
  notified: string[];
}

/** What sendFamilyMessageCore did. */
export interface FamilyMessageResult {
  /** sent: to the named caregiver(s) or, with no name, to every reachable caregiver;
   * sent_to_family: the named person is not a reachable caregiver, so every reachable caregiver
   * got it; unreachable: stored, but nobody could be texted; already_sent: the same message
   * went out moments ago; rate_limited: the hourly cap was reached and nothing was stored. */
  status: "sent" | "sent_to_family" | "unreachable" | "already_sent" | "rate_limited";
  messageId: Id<"familyMessages"> | null;
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
 * purpose: Whether a caregiver can be texted (has a verified phone).
 * @param member: (Doc<"householdMembers">) The caregiver.
 * @return: (boolean) True when a notification row for them has a route.
 */
export function isReachable(member: Doc<"householdMembers">): boolean {
  return verifiedPhone(member) !== undefined;
}

/**
 * purpose: Who a flag goes to: the on-call caregiver when reachable, else every reachable one.
 * @param members: (Doc<"householdMembers">[]) The household's caregivers.
 * @param household: (Doc<"households">) The household.
 * @return: (Doc<"householdMembers">[]) The recipients; empty when nobody is reachable.
 */
export function flagRecipients(
  members: Doc<"householdMembers">[],
  household: Doc<"households">,
): Doc<"householdMembers">[] {
  const reachable = members.filter(isReachable);
  const onCall = reachable.find((m) => m.userId === household.onCallUserId);
  return onCall ? [onCall] : reachable;
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
 * purpose: The flag detail a caregiver receives: one line, at most the first
 *          MAX_FLAG_SENTENCES sentences, long digit runs removed, at most
 *          MAX_FLAG_DETAIL_LENGTH characters.
 * @param text: (string) The detail as written by the model or log_dose.
 * @return: (string) The capped detail ("" for blank text).
 */
export function flagDetail(text: string): string {
  const kept = singleLine(text)
    .replace(/\d(?:[\s-]?\d){5,}/g, NUMBER_REMOVED)
    .split(/(?<=[.!?])\s+/)
    .slice(0, MAX_FLAG_SENTENCES)
    .join(" ");
  if (kept.length <= MAX_FLAG_DETAIL_LENGTH) return kept;
  return `${kept.slice(0, MAX_FLAG_DETAIL_LENGTH - 3).trimEnd()}...`;
}

/**
 * purpose: The household's flag decisions (audit rows) made within a window.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param since: (number) Epoch ms; rows whose detail.at is older are left out.
 * @param scan: (number) Newest audit rows read.
 * @return: (Promise<Doc<"auditLog">[]>) Rows, newest first.
 */
async function recentFlagAudits(
  ctx: QueryCtx,
  householdId: Id<"households">,
  since: number,
  scan: number,
): Promise<Doc<"auditLog">[]> {
  const rows = await ctx.db
    .query("auditLog")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .order("desc")
    .take(scan);
  return rows.filter(
    (r) => r.action === "flag_caregiver" && typeof r.detail.at === "number" && r.detail.at >= since,
  );
}

/**
 * purpose: Ask a caregiver to look in: queue an agent_flag notification to the on-call
 *          caregiver (or every reachable caregiver) and audit the decision, unless the same
 *          key reached family in the last 10 minutes or the hourly cap is reached. Nobody is
 *          named as told unless a row was queued for them.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, reason, detail, key, repeatWindowMs, conversationId, now}) The
 *        household, why, a short description for the caregiver (capped by flagDetail; blank
 *        sends the title only), the repeat key (default: the reason), how long a delivered flag
 *        with that key suppresses another (default 10 minutes), the conversation it came from,
 *        and the clock.
 * @return: (Promise<FlagResult>) The status and the caregivers named as told.
 */
export async function flagCaregiverCore(
  ctx: MutationCtx,
  args: {
    household: Doc<"households">;
    reason: FlagReason;
    detail: string;
    key?: string;
    repeatWindowMs?: number;
    conversationId?: Id<"conversations">;
    now: number;
  },
): Promise<FlagResult> {
  const { household, reason, now } = args;
  const key = args.key ?? reason;
  const repeatWindow = args.repeatWindowMs ?? FLAG_REPEAT_WINDOW_MS;
  const detail = flagDetail(args.detail);
  const recent = await recentFlagAudits(
    ctx,
    household._id,
    now - Math.max(HOUR_MS, repeatWindow),
    repeatWindow > HOUR_MS ? LONG_AUDIT_SCAN : RECENT_AUDIT_SCAN,
  );
  const delivered = recent.filter((r) => r.detail.status === "flagged");
  const earlier = delivered.find(
    (r) => r.detail.key === key && (r.detail.at as number) >= now - repeatWindow,
  );
  const lastHour = delivered.filter((r) => (r.detail.at as number) >= now - HOUR_MS);
  let status: FlagResult["status"];
  let recipients: Doc<"householdMembers">[] = [];
  if (earlier) {
    return { status: "already_flagged", notified: (earlier.detail.names as string[]) ?? [] };
  } else if (lastHour.length >= MAX_FLAGS_PER_HOUR) {
    status = "rate_limited";
  } else {
    recipients = flagRecipients(await householdCaregivers(ctx, household._id), household);
    status = recipients.length > 0 ? "flagged" : "unreachable";
  }
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
  const names = recipients.map((m) => m.displayName);
  await audit(ctx, {
    householdId: household._id,
    actor: VOICE_AGENT,
    action: "flag_caregiver",
    entity: "household",
    entityId: household._id,
    detail: {
      status,
      reason,
      key,
      at: now,
      detail,
      conversationId: args.conversationId ?? null,
      recipients: recipients.map((m) => m.userId),
      names,
    },
  });
  return { status, notified: names };
}

/**
 * purpose: The senior's messages sent within the last hour.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms (compared with the rows' creation time).
 * @return: (Promise<Doc<"familyMessages">[]>) Rows, newest first.
 */
async function recentSeniorMessages(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<Doc<"familyMessages">[]> {
  const rows = await ctx.db
    .query("familyMessages")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .order("desc")
    .take(RECENT_MESSAGE_SCAN);
  return rows.filter((r) => r.senderKind === "senior" && r._creationTime >= now - HOUR_MS);
}

/**
 * purpose: Send a message the senior dictated to family: store it as a familyMessages row from
 *          the senior (body "For <name>: <message>" when a name was given), queue a
 *          family_message notification with the same text to the named reachable caregiver
 *          (or every reachable caregiver) and audit it. An identical message within 2 minutes
 *          is not sent again; past 10 messages an hour nothing is stored. Each outcome is
 *          audited.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, to, body, conversationId, now}) The household, the name the senior
 *        used (blank for "my family"; one line, at most 60 characters), the message (trimmed;
 *        the stored body is cut to 1000 characters), the conversation it came from and the
 *        clock (the server clock: it is compared with row creation times).
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
    now: number;
  },
): Promise<FamilyMessageResult> {
  const { household, now } = args;
  const words = args.body.trim();
  if (words === "") throw appError("invalid", "The message is empty");
  const to = singleLine(args.to).slice(0, MAX_NAME_LENGTH);
  const body = (to === "" ? words : `For ${to}: ${words}`).slice(0, MAX_MESSAGE_LENGTH);
  const recent = await recentSeniorMessages(ctx, household._id, now);
  const repeat = recent.find(
    (r) => r.body === body && r._creationTime >= now - MESSAGE_REPEAT_WINDOW_MS,
  );
  let result: FamilyMessageResult;
  let recipients: Doc<"householdMembers">[] = [];
  if (repeat) {
    result = { status: "already_sent", messageId: repeat._id, recipients: [] };
  } else if (recent.length >= MAX_MESSAGES_PER_HOUR) {
    result = { status: "rate_limited", messageId: null, recipients: [] };
  } else {
    const reachable = (await householdCaregivers(ctx, household._id)).filter(isReachable);
    const named = membersNamed(reachable, to);
    recipients = named.length > 0 ? named : reachable;
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
    const status =
      recipients.length === 0
        ? "unreachable"
        : to !== "" && named.length === 0
          ? "sent_to_family"
          : "sent";
    result = { status, messageId, recipients: recipients.map((m) => m.displayName) };
  }
  await audit(ctx, {
    householdId: household._id,
    actor: VOICE_AGENT,
    action: "send",
    entity: "familyMessage",
    entityId: result.messageId ?? undefined,
    detail: {
      status: result.status,
      to: to === "" ? null : to,
      conversationId: args.conversationId ?? null,
      recipients: recipients.map((m) => m.userId),
    },
  });
  return result;
}
