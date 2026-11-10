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
// told. A flag goes to the on-call caregiver when reachable, else to every reachable caregiver;
// a distress flag always goes to every reachable caregiver.
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
// Repeats and caps (every decision is an audit row with detail.status, detail.at and the
// detail text, including a repeat that was not sent):
// - Only an identical event is a repeat. A model flag's key is its reason plus its detail
//   (lib/text.textKey); log_dose's flags are keyed on the medication (medication_limit:<task>,
//   repeated_use:<task>). A flag whose key reached family in the last 10 minutes (or the
//   caller's longer window: a week for repeated use) is not sent again (already_flagged, naming
//   who was told). A different detail within the window is sent.
// - At most 12 symptom, money_request and scam flags per household per hour reach family
//   (rate_limited after that). distress, help_requested, medication_limit, repeated_use and a
//   dose correction are never capped and do not count. The cap counts agentFlags rows, which
//   hold only flags that went out, so held decisions never push sent ones out of the count.
// - An identical message from the senior within 2 minutes is not sent again (already_sent,
//   with the earlier outcome and recipients from its audit row).
// - At most 10 messages from the senior per household per hour (rate_limited after that; the
//   message is not stored).
// - Taking back a dose that raised a medication_limit flag sends the same caregivers a short
//   correction (sendDoseCorrection), uncapped.
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
import { oneLine, textKey } from "./text";
import { HOUR_MS, MINUTE_MS } from "./time";

/** Why the model may flag a caregiver (a fall is distress; log_dose raises its own two). */
export const modelFlagReason = v.union(
  v.literal("symptom"),
  v.literal("money_request"),
  v.literal("scam"),
  v.literal("distress"),
  v.literal("help_requested"),
);
/** Every reason a flag can have: the model's, and log_dose's medication_limit and repeated_use. */
type FlagReason = Infer<typeof modelFlagReason> | "medication_limit" | "repeated_use";
/** Reasons the hourly cap applies to; the others always go out and are not counted. */
const CAPPED_REASONS: ReadonlySet<string> = new Set(["symptom", "money_request", "scam"]);

/** The voice agent as an actor (no caregiver behind it). */
export const VOICE_AGENT: Actor = { kind: "agent" };

/** A delivered flag with the same key within this window (ms) is not sent again. */
export const FLAG_REPEAT_WINDOW_MS = 10 * MINUTE_MS;
/** Flags that may reach family per household per hour. */
const MAX_FLAGS_PER_HOUR = 12;
/** An identical senior message within this window (ms) is not sent again. */
const MESSAGE_REPEAT_WINDOW_MS = 2 * MINUTE_MS;
/** Messages from the senior per household per hour. */
const MAX_MESSAGES_PER_HOUR = 10;
/** Senior messages scanned (newest first) for repeats and the hourly cap. */
const RECENT_MESSAGE_SCAN = MAX_MESSAGES_PER_HOUR + 20;
/** A medication's newest limit flags searched for the one a dose raised. */
const RECENT_FLAG_SCAN = 50;
/** Sentences of a flag detail that reach a caregiver; the rest is dropped. */
const MAX_FLAG_SENTENCES = 2;
/** Hard cap on a flag detail after the sentence cut; longer text ends with "...". */
export const MAX_FLAG_DETAIL_LENGTH = 240;
/** Longest family message sent; longer text is cut, not rejected. */
const MAX_MESSAGE_LENGTH = 1000;
/** Longest recipient name kept in "For <name>:". */
const MAX_NAME_LENGTH = 60;
/** What a long digit run in a flag detail becomes. */
const NUMBER_REMOVED = "[number removed]";

/** Notification title per reason, given the senior's preferred name and the flag's subject. */
const FLAG_TITLES: Record<FlagReason, (name: string, subject: string) => string> = {
  medication_limit: (name) => `${name} went past a medication limit`,
  repeated_use: (name, medication) => `${name} has used ${medication} often`,
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

/** How a new family message went out. */
type SendStatus = "sent" | "sent_to_family" | "unreachable";

/** What sendFamilyMessageCore did. */
export interface FamilyMessageResult {
  /** sent: to the named caregiver(s) or, with no name, to every reachable caregiver;
   * sent_to_family: the named person is not a reachable caregiver, so every reachable caregiver
   * got it; unreachable: stored, but nobody could be texted; already_sent: the same message was
   * handled moments ago (see earlierStatus); rate_limited: the hourly cap was reached and
   * nothing was stored. */
  status: SendStatus | "already_sent" | "rate_limited";
  messageId: Id<"familyMessages"> | null;
  /** Who got it; for already_sent, who got the earlier one. */
  recipients: string[];
  /** For already_sent: how the earlier identical message went out; null otherwise. */
  earlierStatus: SendStatus | null;
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
function isReachable(member: Doc<"householdMembers">): boolean {
  return verifiedPhone(member) !== undefined;
}

/**
 * purpose: Who a flag goes to: every reachable caregiver for distress; otherwise the on-call
 *          caregiver when reachable, else every reachable one.
 * @param members: (Doc<"householdMembers">[]) The household's caregivers.
 * @param household: (Doc<"households">) The household.
 * @param reason: (FlagReason) Why.
 * @return: (Doc<"householdMembers">[]) The recipients; empty when nobody is reachable.
 */
function flagRecipients(
  members: Doc<"householdMembers">[],
  household: Doc<"households">,
  reason: FlagReason,
): Doc<"householdMembers">[] {
  const reachable = members.filter(isReachable);
  if (reason === "distress") return reachable;
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
  const kept = oneLine(text)
    .replace(/\d(?:[\s-]?\d){5,}/g, NUMBER_REMOVED)
    .split(/(?<=[.!?])\s+/)
    .slice(0, MAX_FLAG_SENTENCES)
    .join(" ");
  if (kept.length <= MAX_FLAG_DETAIL_LENGTH) return kept;
  return `${kept.slice(0, MAX_FLAG_DETAIL_LENGTH - 3).trimEnd()}...`;
}

/**
 * purpose: The newest flag with a key that reached family within a window.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param key: (string) The repeat key.
 * @param since: (number) Epoch ms; older flags are left out.
 * @return: (Promise<Doc<"agentFlags"> | null>) The flag, or null.
 */
async function sentFlagWithKey(
  ctx: QueryCtx,
  householdId: Id<"households">,
  key: string,
  since: number,
): Promise<Doc<"agentFlags"> | null> {
  return await ctx.db
    .query("agentFlags")
    .withIndex("by_household_key_at", (q) =>
      q.eq("householdId", householdId).eq("key", key).gte("at", since),
    )
    .order("desc")
    .first();
}

/**
 * purpose: Whether the hourly cap is reached: MAX_FLAGS_PER_HOUR capped-reason flags reached
 *          family in the hour before now.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<boolean>) True when another capped flag must wait.
 */
async function capReached(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<boolean> {
  const lastHour = await ctx.db
    .query("agentFlags")
    .withIndex("by_household_at", (q) => q.eq("householdId", householdId).gte("at", now - HOUR_MS))
    .collect();
  return lastHour.filter((f) => CAPPED_REASONS.has(f.reason)).length >= MAX_FLAGS_PER_HOUR;
}

/**
 * purpose: Ask a caregiver to look in: queue an agent_flag notification (see flagRecipients)
 *          and audit the decision, unless the same event (same key) reached family within the
 *          repeat window or, for a capped reason, the hourly cap is reached. Every decision is
 *          audited with its detail. Nobody is named as told unless a row was queued for them
 *          (already_flagged names who the earlier identical flag reached).
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, reason, detail, key, repeatWindowMs, subject, doseId,
 *        conversationId, now}) The household, why, a short description for the caregiver
 *        (capped by flagDetail; blank sends the title only), the repeat key (default: the reason
 *        plus the detail's textKey), how long a sent flag with that key suppresses another
 *        (default 10 minutes), the title's subject (repeated_use: the medication), the dose a
 *        medication_limit flag is about, the conversation it came from, and the clock.
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
    subject?: string;
    doseId?: Id<"doseLog">;
    conversationId?: Id<"conversations">;
    now: number;
  },
): Promise<FlagResult> {
  const { household, reason, now } = args;
  const detail = flagDetail(args.detail);
  const key = args.key ?? `${reason}:${textKey(detail)}`;
  const repeatWindow = args.repeatWindowMs ?? FLAG_REPEAT_WINDOW_MS;
  const earlier = await sentFlagWithKey(ctx, household._id, key, now - repeatWindow);
  const rateLimited =
    !earlier && CAPPED_REASONS.has(reason) && (await capReached(ctx, household._id, now));
  const recipients =
    earlier || rateLimited
      ? []
      : flagRecipients(await householdCaregivers(ctx, household._id), household, reason);
  const status: FlagResult["status"] = earlier
    ? "already_flagged"
    : rateLimited
      ? "rate_limited"
      : recipients.length > 0
        ? "flagged"
        : "unreachable";
  for (const member of recipients) {
    await insertNotification(ctx, {
      householdId: household._id,
      kind: "agent_flag",
      title: FLAG_TITLES[reason](household.seniorPreferredName, args.subject ?? ""),
      body: detail,
      payload: { reason, flaggedAt: now, conversationId: args.conversationId ?? null },
      recipientUserId: member.userId,
    });
  }
  const names = earlier ? earlier.names : recipients.map((m) => m.displayName);
  if (status === "flagged") {
    await ctx.db.insert("agentFlags", {
      householdId: household._id,
      reason,
      key,
      at: now,
      names,
      recipientUserIds: recipients.map((m) => m.userId),
      doseId: args.doseId,
      conversationId: args.conversationId,
    });
  }
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
 * purpose: Tell the caregivers a dose's medication_limit flag reached that she took the dose
 *          back: one short agent_flag text each, never capped, audited as flag_correction.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, taskId, doseId, conversationId, now}) The household, the
 *        medication, the dose taken back, the conversation and the clock.
 * @return: (Promise<string[]>) The caregivers' names; empty when the dose raised no sent flag.
 */
export async function sendDoseCorrection(
  ctx: MutationCtx,
  args: {
    household: Doc<"households">;
    taskId: Id<"tasks">;
    doseId: Id<"doseLog">;
    conversationId?: Id<"conversations">;
    now: number;
  },
): Promise<string[]> {
  const { household, now } = args;
  const flags = await ctx.db
    .query("agentFlags")
    .withIndex("by_household_key_at", (q) =>
      q.eq("householdId", household._id).eq("key", `medication_limit:${args.taskId}`),
    )
    .order("desc")
    .take(RECENT_FLAG_SCAN);
  const flag = flags.find((f) => f.doseId === args.doseId);
  if (!flag) return [];
  const name = household.seniorPreferredName;
  for (const userId of flag.recipientUserIds) {
    await insertNotification(ctx, {
      householdId: household._id,
      kind: "agent_flag",
      title: `${name} corrected a dose report`,
      body: `${name} said that dose was a mistake; it has been removed.`,
      payload: {
        reason: "correction",
        flaggedAt: now,
        conversationId: args.conversationId ?? null,
      },
      recipientUserId: userId,
    });
  }
  await audit(ctx, {
    householdId: household._id,
    actor: VOICE_AGENT,
    action: "flag_correction",
    entity: "doseLog",
    entityId: args.doseId,
    detail: { recipients: flag.recipientUserIds, names: flag.names, at: now },
  });
  return flag.names;
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
 * purpose: How an earlier message went out, from its send audit row (by_household_action).
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param messageId: (Id<"familyMessages">) The earlier message.
 * @return: (Promise<{status, names}>) Its status and recipients' names; unreachable with no
 *          names when the row is not found.
 */
async function earlierSend(
  ctx: QueryCtx,
  householdId: Id<"households">,
  messageId: Id<"familyMessages">,
): Promise<{ status: SendStatus; names: string[] }> {
  const rows = await ctx.db
    .query("auditLog")
    .withIndex("by_household_action", (q) => q.eq("householdId", householdId).eq("action", "send"))
    .order("desc")
    .take(RECENT_MESSAGE_SCAN);
  const row = rows.find((r) => r.entityId === messageId);
  return {
    status: (row?.detail.status as SendStatus | undefined) ?? "unreachable",
    names: (row?.detail.names as string[] | undefined) ?? [],
  };
}

/**
 * purpose: Send a message the senior dictated to family: store it as a familyMessages row from
 *          the senior (body "For <name>: <message>" when a name was given), queue a
 *          family_message notification with the same text to the named reachable caregiver
 *          (or every reachable caregiver) and audit it. An identical message within 2 minutes
 *          is not sent again (already_sent says how that one went out); past 10 messages an
 *          hour nothing is stored. Each outcome is audited, with the recipients' names.
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
  const to = oneLine(args.to).slice(0, MAX_NAME_LENGTH);
  const body = (to === "" ? words : `For ${to}: ${words}`).slice(0, MAX_MESSAGE_LENGTH);
  const recent = await recentSeniorMessages(ctx, household._id, now);
  const repeat = recent.find(
    (r) => r.body === body && r._creationTime >= now - MESSAGE_REPEAT_WINDOW_MS,
  );
  let result: FamilyMessageResult;
  let recipients: Doc<"householdMembers">[] = [];
  if (repeat) {
    const earlier = await earlierSend(ctx, household._id, repeat._id);
    result = {
      status: "already_sent",
      messageId: repeat._id,
      recipients: earlier.names,
      earlierStatus: earlier.status,
    };
  } else if (recent.length >= MAX_MESSAGES_PER_HOUR) {
    result = { status: "rate_limited", messageId: null, recipients: [], earlierStatus: null };
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
    const status: SendStatus =
      recipients.length === 0
        ? "unreachable"
        : to !== "" && named.length === 0
          ? "sent_to_family"
          : "sent";
    result = {
      status,
      messageId,
      recipients: recipients.map((m) => m.displayName),
      earlierStatus: null,
    };
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
      names: recipients.map((m) => m.displayName),
    },
  });
  return result;
}
