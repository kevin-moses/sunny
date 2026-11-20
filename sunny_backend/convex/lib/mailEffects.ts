import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { addEventCore, updateEventCore } from "../calendar";
import type { Actor } from "./access";
import { postMail } from "./chatPosts";
import { insertNotification, pushToCaregivers } from "./delivery";
import { linkDomain } from "./mailLinks";
import { appointmentTitle } from "./mailTypes";
import type { MailEffect, MailSender, PolicyFacts } from "./mailTypes";
import type { MailEffectRecord } from "./validators";

const MAIL_AGENT: Actor = { kind: "agent" };
const SENIOR_NOTE_TITLE = "Sunny";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  mailEscalationPush: { kind: "token bucket", rate: 6, period: HOUR, capacity: 6 },
});

interface EffectScope {
  ctx: MutationCtx;
  household: Doc<"households">;
  item: Doc<"mailItems">;
  facts: PolicyFacts;
  events: Map<string, Doc<"events">>;
}

type EffectKind = MailEffect["kind"];
type EffectOf<K extends EffectKind> = Extract<MailEffect, { kind: K }>;
type Handlers = {
  [K in EffectKind]: (scope: EffectScope, effect: EffectOf<K>) => Promise<MailEffectRecord>;
};

async function linkOf(
  ctx: QueryCtx,
  householdId: Id<"households">,
  senderDomain: string,
  appointmentKey: string,
): Promise<Doc<"mailEventLinks"> | null> {
  return await ctx.db
    .query("mailEventLinks")
    .withIndex("by_household_domain_key", (q) =>
      q
        .eq("householdId", householdId)
        .eq("senderDomain", senderDomain)
        .eq("appointmentKey", appointmentKey),
    )
    .unique();
}

export async function senderLink(
  ctx: QueryCtx,
  householdId: Id<"households">,
  sender: MailSender,
  appointmentKey: string,
): Promise<Doc<"mailEventLinks"> | null> {
  const senderDomain = linkDomain(sender);
  return senderDomain === null
    ? null
    : await linkOf(ctx, householdId, senderDomain, appointmentKey);
}

async function linkEvent(scope: EffectScope, eventId: Id<"events">, key: string): Promise<void> {
  const { ics, sender } = scope.facts;
  const senderDomain = linkDomain(sender);
  if (senderDomain === null) {
    throw new Error("The mail plan links an event for a sender Gmail did not verify");
  }
  const sequence = ics?.sequence;
  const existing = await linkOf(scope.ctx, scope.household._id, senderDomain, key);
  if (existing === null) {
    await scope.ctx.db.insert("mailEventLinks", {
      householdId: scope.household._id,
      eventId,
      appointmentKey: key,
      senderDomain,
      senderAddress: sender.address,
      mailItemId: scope.item._id,
      sequence,
    });
  } else if (existing.eventId !== eventId || existing.sequence !== sequence) {
    await scope.ctx.db.patch(existing._id, { eventId, sequence });
  }
}

function eventOf(scope: EffectScope, eventId: string): Doc<"events"> {
  const event = scope.events.get(eventId);
  if (event === undefined)
    throw new Error(`The mail plan names event ${eventId} that Sunny did not give it`);
  return event;
}

async function postToCaregivers(
  scope: EffectScope,
  effect: EffectOf<"tell_caregivers" | "escalate">,
): Promise<void> {
  const { ctx, household, item } = scope;
  const postId = await postMail(ctx, household, item._id, effect.body, scope.facts.now);
  await ctx.db.patch(item._id, { caregiverPost: { postId, line: effect.line } });
}

const HANDLERS: Handlers = {
  add_event: async (scope, effect) => {
    const { date, time, durationMinutes } = effect.appointment;
    const added = await addEventCore(
      scope.ctx,
      MAIL_AGENT,
      scope.household._id,
      {
        title: appointmentTitle(effect.appointment.kind, time),
        onDate: date,
        startTime: time,
        durationMinutes: durationMinutes ?? undefined,
      },
      scope.facts.now,
    );
    await linkEvent(scope, added.eventId, effect.appointmentKey);
    return { kind: "event_added", eventId: added.eventId };
  },
  reschedule_event: async (scope, effect) => {
    const event = eventOf(scope, effect.eventId);
    const { date, time, durationMinutes } = effect.appointment;
    await updateEventCore(
      scope.ctx,
      MAIL_AGENT,
      scope.household._id,
      event._id,
      {
        onDate: date,
        startTime: time,
        ...(durationMinutes === null ? {} : { durationMinutes }),
      },
      scope.facts.now,
    );
    await linkEvent(scope, event._id, effect.appointmentKey);
    return {
      kind: "event_rescheduled",
      eventId: event._id,
      fromDate: event.startsOn,
      fromTime: event.startTime,
    };
  },
  already_on_calendar: async (scope, effect) => {
    const event = eventOf(scope, effect.eventId);
    await linkEvent(scope, event._id, effect.appointmentKey);
    return { kind: "already_on_calendar", eventId: event._id };
  },
  senior_note: async (scope, effect) => {
    const { ctx, household } = scope;
    const noteId = await ctx.db.insert("seniorNotes", {
      householdId: household._id,
      mailItemId: scope.item._id,
      text: effect.text,
      receivedAt: scope.facts.receivedAt,
      expiresAt: effect.expiresAt,
    });
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_household", (q) => q.eq("householdId", household._id))
      .collect();
    for (const device of devices.filter((d) => d.kind === "senior_phone")) {
      await insertNotification(ctx, {
        householdId: household._id,
        kind: "senior_note",
        title: SENIOR_NOTE_TITLE,
        body: effect.text,
        payload: { noteId },
        recipientDeviceId: device._id,
        seniorNoteId: noteId,
      });
    }
    return { kind: "senior_note", noteId };
  },
  tell_caregivers: async (scope, effect) => {
    await postToCaregivers(scope, effect);
    const pushed =
      effect.push &&
      (await pushToCaregivers(scope.ctx, scope.household, {
        kind: "mail_update",
        title: effect.title,
        body: effect.notice,
        payload: { mailItemId: scope.item._id },
      }));
    return { kind: "told_caregivers", pushed };
  },
  escalate: async (scope, effect) => {
    const { ctx, household } = scope;
    await postToCaregivers(scope, effect);
    const pushed =
      effect.push &&
      (await pushToCaregivers(
        ctx,
        household,
        {
          kind: "mail_escalation",
          title: `Email for ${household.seniorPreferredName} needs you`,
          body: effect.notice,
          payload: { mailItemId: scope.item._id },
        },
        async () => (await rateLimiter.limit(ctx, "mailEscalationPush", { key: household._id })).ok,
      ));
    return {
      kind: "escalated",
      reason: effect.reason,
      pushed,
      ...(effect.eventId === null ? {} : { eventId: eventOf(scope, effect.eventId)._id }),
      ...(effect.proposed === null ? {} : { proposed: effect.proposed }),
    };
  },
};

async function runEffect<K extends EffectKind>(
  scope: EffectScope,
  kind: K,
  effect: EffectOf<K>,
): Promise<MailEffectRecord> {
  return await HANDLERS[kind](scope, effect);
}

export async function carryOut(
  scope: EffectScope,
  effects: readonly MailEffect[],
): Promise<MailEffectRecord[]> {
  const records: MailEffectRecord[] = [];
  for (const effect of effects) records.push(await runEffect(scope, effect.kind, effect));
  return records;
}
