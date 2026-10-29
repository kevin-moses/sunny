// convex/sms.ts
// Purpose: Sunny's inbound SMS channel on Twilio (outbound sending: lib/twilio.ts, called
// directly by the delivery and phone actions). A caregiver can answer an escalation alert from
// the phone.
//
// Inbound: POST /twilio/sms (http.ts) refuses (503) unless TWILIO_AUTH_TOKEN and
// TWILIO_WEBHOOK_URL are set (the URL must equal, character for character, the webhook URL in
// the Twilio console), refuses (403) a request with no valid X-Twilio-Signature before reading
// anything, then handleInbound decides the reply, which goes back as TwiML. A MessageSid is
// handled once: a retry gets the stored reply and claims nothing again (records swept hourly).
// Only verified member numbers (phone.ts) are recognised; an unknown number, and Twilio's own
// opt-out and help keywords (STOP, HELP, ...), get an empty response.
//
// Reply "1" or "on it" acts on exactly one alert: the newest caregiver_alert that was actually
// texted (state sent, channel sms) to the member in the last 24 hours, across the households
// the number belongs to. If its task is open it is claimed through the same claimInstance the
// app uses, with an extra audit row "claim_via sms"; otherwise the reply says who is on it or
// that it is closed. Older alerts are never used instead. Viewers cannot claim.
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_WEBHOOK_URL.
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { httpAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { findMember, verifiedPhone } from "./lib/access";
import type { CaregiverActor } from "./lib/access";
import { audit } from "./lib/audit";
import { claimInstance } from "./instances";
import { isE164, twiml, validateTwilioSignature, webhookUrl } from "./lib/twilio";

const ALERT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const ALERTS_PER_MEMBER = 20;
const MAX_COMMAND_LENGTH = 100;
const HANDLED_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;
/** Reply to "1" when nothing is open for the member. */
export const NOTHING_OPEN_REPLY =
  "Nothing needs claiming right now. When Sunny alerts you about a task, reply 1 to say you're on it.";
/** Reply to a message that is not a command. */
export const HELP_REPLY =
  "Reply 1 when you're on it for a task Sunny alerted you about. Reply STOP to opt out.";
/** Reply when the newest alert's task is no longer open and nobody is on it. */
export const CLOSED_REPLY = "That one is already closed";
/** Reply when every matching account is a viewer. */
export const VIEWER_REPLY = "Your Sunny account can view tasks but not claim them.";

/** Keywords Twilio answers itself; Sunny must not reply to them. */
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

/** What an inbound message asks for. */
export type SmsCommand = "claim" | "twilio_keyword" | "other";

/**
 * purpose: Classify an inbound message body.
 * @param body: (string) Message text.
 * @return: (SmsCommand) "claim" for "1" or "on it" (case-insensitive, trailing . or !
 *          ignored), "twilio_keyword" for STOP, HELP and the like, otherwise "other".
 */
export function parseCommand(body: string): SmsCommand {
  const text = body
    .slice(0, MAX_COMMAND_LENGTH)
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/, "");
  if (text === "1" || text === "on it") return "claim";
  return TWILIO_KEYWORDS.has(text) ? "twilio_keyword" : "other";
}

/** The newest alert texted to a member, with the task instance it is about. */
interface SentAlert {
  member: Doc<"householdMembers">;
  instance: Doc<"taskInstances">;
  alertAt: number;
}

/**
 * purpose: The newest caregiver alert actually texted to a member (state sent, channel sms) in
 *          the last 24 hours. The lookup is by recipient and kind, so other kinds of rows never
 *          push alerts out of reach. Only that one alert counts: if its instance is gone the
 *          answer is null, not an older alert.
 * @param ctx: (MutationCtx) Context.
 * @param member: (Doc<"householdMembers">) The member.
 * @param now: (number) Epoch ms.
 * @return: (Promise<SentAlert | null>) The alert, or null.
 */
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

/**
 * purpose: The sentence naming a task and the senior, for replies.
 * @param ctx: (MutationCtx) Context.
 * @param instance: (Doc<"taskInstances">) The instance.
 * @return: (Promise<string>) For example "Morning pills for Margaret".
 */
async function describeTask(ctx: MutationCtx, instance: Doc<"taskInstances">): Promise<string> {
  const task = await ctx.db.get(instance.taskId);
  const household = await ctx.db.get(instance.householdId);
  return `${task?.displayLabel ?? "a task"} for ${household?.seniorPreferredName ?? "your family member"}`;
}

/**
 * purpose: Answer "1" for the members behind a phone number: act on the single newest alert
 *          texted to any of them. Open and unclaimed: claim it. Otherwise say who is on it, or
 *          that it is closed. Never falls back to an older alert.
 * @param ctx: (MutationCtx) Context.
 * @param editors: (Doc<"householdMembers">[]) Verified members with this number who may claim.
 * @param now: (number) Epoch ms.
 * @return: (Promise<string>) The reply text.
 */
async function claimForMembers(
  ctx: MutationCtx,
  editors: Doc<"householdMembers">[],
  now: number,
): Promise<string> {
  const alerts: SentAlert[] = [];
  for (const member of editors) {
    const alert = await newestSentAlert(ctx, member, now);
    if (alert) alerts.push(alert);
  }
  alerts.sort((a, b) => b.alertAt - a.alertAt);
  const newest = alerts[0];
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

/**
 * purpose: Work out the reply to one inbound SMS and apply any claim. A number that is not a
 *          verified member gets no reply, and reveals nothing about any household.
 * @param ctx: (MutationCtx) Context.
 * @param from: (string) Sender, E.164.
 * @param body: (string) Message text.
 * @return: (Promise<string | null>) The reply text, or null for an empty response.
 */
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

/**
 * purpose: Handle one inbound SMS once. A MessageSid already handled gets the stored reply and
 *          changes nothing, so Twilio's retries are safe.
 * @param from: (string) Sender, E.164 (Twilio's From).
 * @param body: (string) Message text.
 * @param messageSid: (string) Twilio's MessageSid; empty skips the once-only check.
 * @return: ({reply}) The reply text, or null for an empty response.
 */
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

/**
 * purpose: Delete handled-message records past their expiry (hourly cron). Internal.
 * @return: (number) Rows deleted (at most one batch per run).
 */
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

/** Response headers for TwiML. */
const XML_HEADERS = { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" };

/**
 * purpose: POST /twilio/sms, Twilio's inbound SMS webhook. Answers 503 (and logs) when the auth
 *          token or TWILIO_WEBHOOK_URL is not set, 403 for a missing or invalid
 *          X-Twilio-Signature (checked before the body is read), otherwise TwiML.
 * @param request: (Request) Twilio's form-encoded request.
 * @return: (Response) TwiML 200; 403 for a bad or missing signature; 503 when not configured.
 */
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
