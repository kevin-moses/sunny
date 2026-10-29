// convex/sms.ts
// Purpose: Sunny's SMS channel on Twilio (REST, see lib/twilio.ts for why not the
// component). Caregivers have no app yet, so alerts, day-of notices and the digest go out by
// SMS, and a caregiver can answer an escalation alert from the phone.
//
// Outbound: internal.sms.send({ to, body }) is the contract for the outbox dispatcher. It
// returns { ok: true, sid } or { ok: false, retryable, error } and throws only for missing
// configuration (message starts "SMS is not configured"). retryable is true for a network
// error, timeout, 429 or 5xx, false for any other Twilio rejection.
//
// Inbound: POST /twilio/sms (http.ts) validates X-Twilio-Signature (403 without a valid
// one), then handleInbound decides the reply, which goes back as TwiML. Only verified member
// numbers (phone.ts) are recognised. "1" or "on it" (any case, trailing punctuation ignored)
// claims the newest open task (state due or escalated, unclaimed) that the member was sent a
// caregiver_alert for in the last 24 hours, across every household the number belongs to,
// through the same claimInstance the app uses; an extra audit row records via "sms". Viewers
// cannot claim. Twilio's own opt-out and help keywords (STOP, HELP, ...) get an empty
// response so Twilio's built-in reply is the only one. An unknown or unverified number gets a
// generic reply that reveals nothing.
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, optional TWILIO_WEBHOOK_URL.
//
// Last modified: 2026-10-29

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { httpAction, internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { findMember } from "./lib/access";
import type { CaregiverActor } from "./lib/access";
import { audit } from "./lib/audit";
import { claimInstance } from "./instances";
import {
  isE164,
  sendTwilioSms,
  twiml,
  twilioConfig,
  validateTwilioSignature,
  webhookUrl,
} from "./lib/twilio";
import type { SmsResult } from "./lib/twilio";

const ALERT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const ALERTS_PER_MEMBER = 50;
const MAX_COMMAND_LENGTH = 100;

/** Reply to a number that is not a verified member; reveals nothing about any household. */
export const UNKNOWN_NUMBER_REPLY =
  "This number is not set up with Sunny. Add it in the Sunny app to get alerts.";
/** Reply to "1" when nothing is open for the member. */
export const NOTHING_OPEN_REPLY =
  "Nothing needs claiming right now. When Sunny alerts you about a task, reply 1 to say you're on it.";
/** Reply to a message that is not a command. */
export const HELP_REPLY =
  "Reply 1 when you're on it for a task Sunny alerted you about. Reply STOP to opt out.";
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

/**
 * purpose: Send one SMS. The contract for the notification dispatcher.
 * @param to: (string) Destination, E.164.
 * @param body: (string) Message text.
 * @return: (SmsResult) { ok: true, sid } or { ok: false, retryable, error }.
 * @raises Error "SMS is not configured: ..." when the Twilio environment is incomplete.
 */
export const send = internalAction({
  args: { to: v.string(), body: v.string() },
  handler: async (_ctx, args): Promise<SmsResult> => {
    const result = await sendTwilioSms(twilioConfig(), args.to, args.body);
    if (!result.ok) {
      console.error(`sms: send failed (retryable: ${result.retryable}): ${result.error}`);
    }
    return result;
  },
});

/** An open alert a member could claim, or one that someone already claimed. */
interface AlertCandidate {
  member: Doc<"householdMembers">;
  instance: Doc<"taskInstances">;
  alertAt: number;
}

/**
 * purpose: The task instances a member was sent caregiver alerts for in the last 24 hours,
 *          newest alert first, each instance once.
 * @param ctx: (MutationCtx) Context.
 * @param member: (Doc<"householdMembers">) The member.
 * @param now: (number) Epoch ms.
 * @return: (Promise<AlertCandidate[]>) Candidates, newest first.
 */
async function recentAlerts(
  ctx: MutationCtx,
  member: Doc<"householdMembers">,
  now: number,
): Promise<AlertCandidate[]> {
  const rows = await ctx.db
    .query("notificationOutbox")
    .withIndex("by_recipient_user", (q) =>
      q.eq("recipientUserId", member.userId).gte("_creationTime", now - ALERT_LOOKBACK_MS),
    )
    .order("desc")
    .take(ALERTS_PER_MEMBER);
  const seen = new Set<string>();
  const found: AlertCandidate[] = [];
  for (const row of rows) {
    if (
      row.kind !== "caregiver_alert" ||
      row.householdId !== member.householdId ||
      row.taskInstanceId === undefined ||
      seen.has(row.taskInstanceId)
    ) {
      continue;
    }
    seen.add(row.taskInstanceId);
    const instance = await ctx.db.get(row.taskInstanceId);
    if (instance) found.push({ member, instance, alertAt: row._creationTime });
  }
  return found;
}

/**
 * purpose: Whether an instance is still waiting for someone: due or escalated and unclaimed.
 * @param instance: (Doc<"taskInstances">) The instance.
 * @return: (boolean) True when it can be claimed by SMS.
 */
function isOpen(instance: Doc<"taskInstances">): boolean {
  return (
    (instance.state === "due" || instance.state === "escalated") && instance.claimedBy === undefined
  );
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
 * purpose: Claim the newest open alerted task for the members behind a phone number, or say
 *          why nothing was claimed.
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
  const all: AlertCandidate[] = [];
  for (const member of editors) all.push(...(await recentAlerts(ctx, member, now)));
  all.sort((a, b) => b.alertAt - a.alertAt);

  let taken: AlertCandidate | undefined;
  for (const candidate of all) {
    const { member, instance } = candidate;
    if (isOpen(instance)) {
      const actor: CaregiverActor = {
        kind: "caregiver",
        userId: member.userId,
        householdId: member.householdId,
        role: member.role,
        member,
      };
      const after = await claimInstance(ctx, actor, { instanceId: instance._id }, now);
      if (after.claimedBy !== member.userId) continue;
      await audit(ctx, {
        householdId: instance.householdId,
        actor,
        action: "claim_via",
        entity: "task_instance",
        entityId: instance._id,
        detail: { via: "sms" },
      });
      return `Thanks, ${member.displayName}. You're on it: ${await describeTask(ctx, instance)}.`;
    }
    const stillOpen = instance.state === "due" || instance.state === "escalated";
    if (stillOpen && instance.claimedBy !== undefined && taken === undefined) taken = candidate;
  }
  if (!taken) return NOTHING_OPEN_REPLY;
  const { member, instance } = taken;
  const task = await describeTask(ctx, instance);
  if (instance.claimedBy === member.userId) {
    return `You're already on it, ${member.displayName}: ${task}.`;
  }
  const claimer = await findMember(ctx, instance.householdId, instance.claimedBy!);
  return `${claimer?.displayName ?? "Another caregiver"} is already on it: ${task}.`;
}

/**
 * purpose: Decide the reply to one inbound SMS and apply any claim. Reveals nothing about
 *          households to a number that is not a verified member.
 * @param from: (string) Sender, E.164 (Twilio's From).
 * @param body: (string) Message text.
 * @return: ({reply}) The reply text, or null when Twilio itself answers (STOP, HELP, ...).
 */
export const handleInbound = internalMutation({
  args: { from: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<{ reply: string | null }> => {
    const command = parseCommand(args.body);
    if (command === "twilio_keyword") return { reply: null };
    const members = isE164(args.from)
      ? (
          await ctx.db
            .query("householdMembers")
            .withIndex("by_phone", (q) => q.eq("phone", args.from))
            .collect()
        ).filter((m) => m.phoneVerifiedAt !== undefined)
      : [];
    if (members.length === 0) return { reply: UNKNOWN_NUMBER_REPLY };
    if (command === "other") return { reply: HELP_REPLY };
    const editors = members.filter((m) => m.role !== "viewer");
    if (editors.length === 0) return { reply: VIEWER_REPLY };
    return { reply: await claimForMembers(ctx, editors, Date.now()) };
  },
});

/** Response headers for TwiML. */
const XML_HEADERS = { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" };

/**
 * purpose: POST /twilio/sms, Twilio's inbound SMS webhook. Rejects a request without a valid
 *          X-Twilio-Signature (403) before reading any field, then answers with TwiML.
 * @param request: (Request) Twilio's form-encoded request.
 * @return: (Response) TwiML 200; 403 for a bad or missing signature; 503 when the Twilio auth
 *          token is not configured.
 */
export const inbound = httpAction(async (ctx, request) => {
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  if (!authToken) return new Response("SMS is not configured", { status: 503 });
  const params = new URLSearchParams(await request.text());
  const signature = request.headers.get("X-Twilio-Signature");
  if (!(await validateTwilioSignature(signature, webhookUrl(), params, authToken))) {
    return new Response("Forbidden", { status: 403 });
  }
  const { reply } = await ctx.runMutation(internal.sms.handleInbound, {
    from: params.get("From") ?? "",
    body: params.get("Body") ?? "",
  });
  return new Response(twiml(reply), { status: 200, headers: XML_HEADERS });
});
