import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { householdCaregivers } from "./access";
import type { Actor } from "./access";
import { audit } from "./audit";
import { insertNotification, reachableMembers } from "./delivery";
import { appError } from "./errors";
import { oneLine, textKey } from "./text";
import { HOUR_MS, MINUTE_MS } from "./time";

export const modelFlagReason = v.union(
  v.literal("symptom"),
  v.literal("money_request"),
  v.literal("scam"),
  v.literal("distress"),
  v.literal("help_requested"),
);
type FlagReason = Infer<typeof modelFlagReason> | "medication_limit" | "repeated_use";
const CAPPED_REASONS: ReadonlySet<string> = new Set(["symptom", "money_request", "scam"]);

export const VOICE_AGENT: Actor = { kind: "agent" };

export const FLAG_REPEAT_WINDOW_MS = 10 * MINUTE_MS;
const MAX_FLAGS_PER_HOUR = 12;
const MESSAGE_REPEAT_WINDOW_MS = 2 * MINUTE_MS;
const MAX_MESSAGES_PER_HOUR = 10;
const RECENT_MESSAGE_SCAN = MAX_MESSAGES_PER_HOUR + 20;
const RECENT_FLAG_SCAN = 50;
const MAX_FLAG_SENTENCES = 2;
export const MAX_FLAG_DETAIL_LENGTH = 240;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_NAME_LENGTH = 60;
const NUMBER_REMOVED = "[number removed]";

const FLAG_TITLES: Record<FlagReason, (name: string, subject: string) => string> = {
  medication_limit: (name) => `${name} went past a medication limit`,
  repeated_use: (name, medication) => `${name} has used ${medication} often`,
  symptom: (name) => `${name} mentioned a symptom`,
  money_request: (name) => `${name} was asked for money`,
  scam: (name) => `${name} may be facing a scam`,
  distress: (name) => `${name} sounded distressed`,
  help_requested: (name) => `${name} asked for you`,
};

export interface FlagResult {
  status: "flagged" | "already_flagged" | "unreachable" | "rate_limited";
  notified: string[];
}

type SendStatus = "sent" | "sent_to_family" | "unreachable";

export interface FamilyMessageResult {
  status: SendStatus | "already_sent" | "rate_limited";
  messageId: Id<"familyMessages"> | null;
  recipients: string[];
  earlierStatus: SendStatus | null;
}

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

export function flagDetail(text: string): string {
  const kept = oneLine(text)
    .replace(/\d(?:[\s-]?\d){5,}/g, NUMBER_REMOVED)
    .split(/(?<=[.!?])\s+/)
    .slice(0, MAX_FLAG_SENTENCES)
    .join(" ");
  if (kept.length <= MAX_FLAG_DETAIL_LENGTH) return kept;
  return `${kept.slice(0, MAX_FLAG_DETAIL_LENGTH - 3).trimEnd()}...`;
}

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
      : await reachableMembers(ctx, await householdCaregivers(ctx, household._id));
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
    const reachable = await reachableMembers(ctx, await householdCaregivers(ctx, household._id));
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
