import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { httpAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { findMember, verifiedPhone } from "./lib/access";
import type { CaregiverActor } from "./lib/access";
import { audit } from "./lib/audit";
import { SMS_KIND_POLICY } from "./lib/delivery";
import type { NotificationKind } from "./lib/validators";
import { claimInstance } from "./instances";
import { isE164, twiml, validateTwilioSignature, webhookUrl } from "./lib/twilio";

const ALERT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const ALERTS_PER_MEMBER = 20;
const MAX_COMMAND_LENGTH = 100;
const HANDLED_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;
export const NOTHING_OPEN_REPLY =
  "Nothing needs claiming right now. When Sunny alerts you about a task, reply 1 to say you're on it.";
export const MESSAGE_REPLY = "Thanks. Nothing needs claiming for that message.";
export const HELP_REPLY =
  "Reply 1 when you're on it for a task Sunny alerted you about. Reply STOP to opt out.";
export const CLOSED_REPLY = "That one is already closed";
export const VIEWER_REPLY = "Your Sunny account can view tasks but not claim them.";

const TWILIO_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "start",
  "yes",
  "unstop",
  "help",
  "info",
]);

export type SmsCommand = "claim" | "twilio_keyword" | "other";

export function parseCommand(body: string): SmsCommand {
  const text = body
    .slice(0, MAX_COMMAND_LENGTH)
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/, "");
  if (text === "1" || text === "on it") return "claim";
  return TWILIO_KEYWORDS.has(text) ? "twilio_keyword" : "other";
}

interface SentAlert {
  member: Doc<"householdMembers">;
  instance: Doc<"taskInstances">;
  alertAt: number;
}

async function newestSentAlert(
  ctx: MutationCtx,
  member: Doc<"householdMembers">,
  now: number,
): Promise<SentAlert | null> {
  const rows = await ctx.db
    .query("notificationOutbox")
    .withIndex("by_recipient_kind", (q) =>
      q
        .eq("recipientUserId", member.userId)
        .eq("kind", "caregiver_alert")
        .gte("_creationTime", now - ALERT_LOOKBACK_MS),
    )
    .order("desc")
    .take(ALERTS_PER_MEMBER);
  const row = rows.find(
    (r) =>
      r.householdId === member.householdId &&
      r.state === "sent" &&
      r.channel === "sms" &&
      r.taskInstanceId !== undefined,
  );
  if (!row || row.taskInstanceId === undefined) return null;
  const instance = await ctx.db.get(row.taskInstanceId);
  return instance ? { member, instance, alertAt: row._creationTime } : null;
}

const NOT_ALERT_KINDS = (Object.keys(SMS_KIND_POLICY) as NotificationKind[]).filter(
  (kind) => SMS_KIND_POLICY[kind].hidesOlderAlert,
);

async function newestMessageTextAt(
  ctx: MutationCtx,
  member: Doc<"householdMembers">,
  now: number,
): Promise<number | null> {
  let newest: number | null = null;
  for (const kind of NOT_ALERT_KINDS) {
    const rows = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_recipient_kind", (q) =>
        q
          .eq("recipientUserId", member.userId)
          .eq("kind", kind)
          .gte("_creationTime", now - ALERT_LOOKBACK_MS),
      )
      .order("desc")
      .take(ALERTS_PER_MEMBER);
    const sent = rows.find(
      (r) => r.householdId === member.householdId && r.state === "sent" && r.channel === "sms",
    );
    if (sent && (newest === null || sent._creationTime > newest)) newest = sent._creationTime;
  }
  return newest;
}

async function describeTask(ctx: MutationCtx, instance: Doc<"taskInstances">): Promise<string> {
  const task = await ctx.db.get(instance.taskId);
  const household = await ctx.db.get(instance.householdId);
  return `${task?.displayLabel ?? "a task"} for ${household?.seniorPreferredName ?? "your family member"}`;
}

async function claimForMembers(
  ctx: MutationCtx,
  editors: Doc<"householdMembers">[],
  now: number,
): Promise<string> {
  const alerts: SentAlert[] = [];
  let messageAt: number | null = null;
  for (const member of editors) {
    const alert = await newestSentAlert(ctx, member, now);
    if (alert) alerts.push(alert);
    const at = await newestMessageTextAt(ctx, member, now);
    if (at !== null && (messageAt === null || at > messageAt)) messageAt = at;
  }
  alerts.sort((a, b) => b.alertAt - a.alertAt);
  const newest = alerts[0];
  if (messageAt !== null && (!newest || messageAt > newest.alertAt)) return MESSAGE_REPLY;
  if (!newest) return NOTHING_OPEN_REPLY;
  const { member, instance } = newest;
  const task = await describeTask(ctx, instance);
  const open = instance.state === "due" || instance.state === "escalated";
  if (open && instance.claimedBy === undefined) {
    const actor: CaregiverActor = {
      kind: "caregiver",
      userId: member.userId,
      householdId: member.householdId,
      role: member.role,
      member,
    };
    await claimInstance(ctx, actor, { instanceId: instance._id }, now);
    await audit(ctx, {
      householdId: instance.householdId,
      actor,
      action: "claim_via",
      entity: "task_instance",
      entityId: instance._id,
      detail: { via: "sms" },
    });
    return `Thanks, ${member.displayName}. You're on it: ${task}.`;
  }
  if (open && instance.claimedBy !== undefined) {
    if (instance.claimedBy === member.userId) {
      return `You're already on it, ${member.displayName}: ${task}.`;
    }
    const claimer = await findMember(ctx, instance.householdId, instance.claimedBy);
    return `${claimer?.displayName ?? "Another caregiver"} is already on it: ${task}.`;
  }
  return `${CLOSED_REPLY}: ${task}.`;
}

async function replyTo(ctx: MutationCtx, from: string, body: string): Promise<string | null> {
  const command = parseCommand(body);
  if (command === "twilio_keyword") return null;
  const members = isE164(from)
    ? (
        await ctx.db
          .query("householdMembers")
          .withIndex("by_phone", (q) => q.eq("phone", from))
          .collect()
      ).filter((m) => verifiedPhone(m) !== undefined)
    : [];
  if (members.length === 0) return null;
  if (command === "other") return HELP_REPLY;
  const editors = members.filter((m) => m.role !== "viewer");
  if (editors.length === 0) return VIEWER_REPLY;
  return await claimForMembers(ctx, editors, Date.now());
}

export const handleInbound = internalMutation({
  args: { from: v.string(), body: v.string(), messageSid: v.string() },
  handler: async (ctx, args): Promise<{ reply: string | null }> => {
    if (args.messageSid !== "") {
      const seen = await ctx.db
        .query("smsInbound")
        .withIndex("by_sid", (q) => q.eq("messageSid", args.messageSid))
        .first();
      if (seen) return { reply: seen.reply };
    }
    const reply = await replyTo(ctx, args.from, args.body);
    if (args.messageSid !== "") {
      await ctx.db.insert("smsInbound", {
        messageSid: args.messageSid,
        reply,
        expiresAt: Date.now() + HANDLED_TTL_MS,
      });
    }
    return { reply };
  },
});

export const sweepInbound = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const stale = await ctx.db
      .query("smsInbound")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(SWEEP_BATCH);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});

const XML_HEADERS = { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" };

export const inbound = httpAction(async (ctx, request) => {
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  const url = webhookUrl();
  if (!authToken || !url) {
    console.error("sms: inbound refused; set TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_URL");
    return new Response("SMS is not configured", { status: 503 });
  }
  const signature = request.headers.get("X-Twilio-Signature");
  if (!signature) return new Response("Forbidden", { status: 403 });
  const params = new URLSearchParams(await request.text());
  if (!(await validateTwilioSignature(signature, url, params, authToken))) {
    return new Response("Forbidden", { status: 403 });
  }
  const { reply } = await ctx.runMutation(internal.sms.handleInbound, {
    from: params.get("From") ?? "",
    body: params.get("Body") ?? "",
    messageSid: params.get("MessageSid") ?? "",
  });
  return new Response(twiml(reply), { status: 200, headers: XML_HEADERS });
});
