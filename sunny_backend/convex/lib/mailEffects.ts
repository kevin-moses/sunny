import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { addEventCore, updateEventCore } from "../calendar";
import { householdCaregivers } from "./access";
import type { Actor } from "./access";
import { postMail } from "./chatPosts";
import { insertNotification, reachableMembers } from "./delivery";
import { STALE_AFTER_MS, caregiverMessage } from "./mailPolicy";
import type { Appointment, EscalationReason, MailEffect, PolicyFacts, Slot } from "./mailTypes";
import {
  DAY_MS,
  dateLabel,
  formatTime12,
  isLocalDate,
  isLocalTime,
  localDate,
  weekdayName,
  zonedInstant,
} from "./time";
import type { MailEffectRecord, NotificationKind } from "./validators";

const MAIL_AGENT: Actor = { kind: "agent" };
const MAX_PUSH_BODY = 178;
const SENIOR_NOTE_TITLE = "Sunny";
const MAX_NOTES_PER_DAY = 3;

const rateLimiter = new RateLimiter(components.rateLimiter, {
  mailEscalationPush: { kind: "token bucket", rate: 6, period: HOUR, capacity: 6 },
});

export interface EffectScope {
  ctx: MutationCtx;
  household: Doc<"households">;
  item: Doc<"mailItems">;
  facts: PolicyFacts;
  events: Map<string, Doc<"events">>;
  linkKey: string | null;
  summary: string;
}

type EffectKind = MailEffect["kind"];
type EffectOf<K extends EffectKind> = Extract<MailEffect, { kind: K }>;
type Handlers = {
  [K in EffectKind]: (scope: EffectScope, effect: EffectOf<K>) => Promise<MailEffectRecord>;
};

export interface CaregiverNotice {
  kind: NotificationKind;
  title: string;
  body: string;
  payload: Record<string, string>;
}

export async function linkByKey(
  ctx: QueryCtx,
  householdId: Id<"households">,
  appointmentKey: string,
): Promise<Doc<"mailEventLinks"> | null> {
  return await ctx.db
    .query("mailEventLinks")
    .withIndex("by_household_key", (q) =>
      q.eq("householdId", householdId).eq("appointmentKey", appointmentKey),
    )
    .first();
}

export async function linkForEvent(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"mailEventLinks"> | null> {
  return await ctx.db
    .query("mailEventLinks")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .first();
}

async function linkEvent(scope: EffectScope, eventId: Id<"events">, key: string): Promise<void> {
  const { ics } = scope.facts;
  const sequence = ics !== null && key === `ics:${ics.uid}` ? ics.sequence : undefined;
  const existing = await linkForEvent(scope.ctx, eventId);
  if (existing === null) {
    await scope.ctx.db.insert("mailEventLinks", {
      householdId: scope.household._id,
      eventId,
      appointmentKey: key,
      mailItemId: scope.item._id,
      sequence,
    });
  } else if (existing.appointmentKey !== key || existing.sequence !== sequence) {
    await scope.ctx.db.patch(existing._id, { appointmentKey: key, sequence });
  }
}

function eventOf(scope: EffectScope, eventId: string): Doc<"events"> {
  const event = scope.events.get(eventId);
  if (event === undefined)
    throw new Error(`The mail plan names event ${eventId} that Sunny did not give it`);
  return event;
}

function pushBody(text: string): string {
  return text.length <= MAX_PUSH_BODY ? text : `${text.slice(0, MAX_PUSH_BODY - 3).trimEnd()}...`;
}

export async function pushToCaregivers(
  ctx: MutationCtx,
  household: Doc<"households">,
  notice: CaregiverNotice,
  admit: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  const recipients = await reachableMembers(ctx, await householdCaregivers(ctx, household._id));
  if (recipients.length === 0 || !(await admit())) return false;
  for (const member of recipients) {
    await insertNotification(ctx, {
      householdId: household._id,
      kind: notice.kind,
      title: notice.title,
      body: pushBody(notice.body),
      payload: notice.payload,
      recipientUserId: member.userId,
    });
  }
  return true;
}

function updateTitle(scope: EffectScope, effects: readonly MailEffect[]): string {
  if (effects.some((e) => e.kind === "reschedule_event")) return "Sunny moved an appointment";
  if (effects.some((e) => e.kind === "add_event")) return "Sunny added an appointment";
  return `Sunny read an email for ${scope.household.seniorPreferredName}`;
}

function escalationTitle(scope: EffectScope): string {
  return `Email for ${scope.household.seniorPreferredName} needs you`;
}

async function notesWrittenToday(scope: EffectScope): Promise<number> {
  const { ctx, household, facts } = scope;
  const startOfToday = zonedInstant(
    localDate(facts.now, household.timezone),
    "00:00",
    household.timezone,
  );
  const recent = await ctx.db
    .query("seniorNotes")
    .withIndex("by_household_received", (q) =>
      q.eq("householdId", household._id).gte("receivedAt", startOfToday - STALE_AFTER_MS),
    )
    .collect();
  return recent.filter((note) => note._creationTime >= startOfToday).length;
}

function makeHandlers(effects: readonly MailEffect[]): Handlers {
  return {
    add_event: async (scope, effect) => {
      const { title, date, time, durationMinutes, place } = effect.appointment;
      const added = await addEventCore(
        scope.ctx,
        MAIL_AGENT,
        scope.household._id,
        {
          title,
          onDate: date,
          startTime: time,
          durationMinutes: durationMinutes ?? undefined,
          place: place ?? undefined,
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
      if (scope.linkKey !== null && (await linkForEvent(scope.ctx, event._id)) === null) {
        await linkEvent(scope, event._id, scope.linkKey);
      }
      return { kind: "already_on_calendar", eventId: event._id };
    },
    senior_note: async (scope, effect) => {
      const { ctx, household } = scope;
      if ((await notesWrittenToday(scope)) >= MAX_NOTES_PER_DAY) {
        const line = `Sunny held back this note for the senior because the daily limit of ${MAX_NOTES_PER_DAY} notes was reached: ${effect.text}`;
        const { body } = caregiverMessage(scope.facts, line, scope.summary);
        await postMail(ctx, household, scope.item._id, body, scope.facts.now);
        return { kind: "told_caregivers", pushed: false };
      }
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
      await postMail(scope.ctx, scope.household, scope.item._id, effect.body, scope.facts.now);
      const pushed =
        effect.push &&
        (await pushToCaregivers(scope.ctx, scope.household, {
          kind: "mail_update",
          title: updateTitle(scope, effects),
          body: effect.notice,
          payload: { mailItemId: scope.item._id },
        }));
      return { kind: "told_caregivers", pushed };
    },
    escalate: async (scope, effect) => {
      const { ctx, household } = scope;
      await postMail(ctx, household, scope.item._id, effect.body, scope.facts.now);
      const pushed =
        effect.push &&
        (await pushToCaregivers(
          ctx,
          household,
          {
            kind: "mail_escalation",
            title: escalationTitle(scope),
            body: effect.notice,
            payload: { mailItemId: scope.item._id },
          },
          async () =>
            (await rateLimiter.limit(ctx, "mailEscalationPush", { key: household._id })).ok,
        ));
      return {
        kind: "escalated",
        reason: effect.reason,
        pushed,
        ...(effect.eventId === null ? {} : { eventId: eventOf(scope, effect.eventId)._id }),
        ...(effect.proposed !== null &&
        isLocalDate(effect.proposed.date) &&
        isLocalTime(effect.proposed.time)
          ? { proposed: { date: effect.proposed.date, time: effect.proposed.time } }
          : {}),
      };
    },
  };
}

async function runEffect<K extends EffectKind>(
  handlers: Handlers,
  scope: EffectScope,
  kind: K,
  effect: EffectOf<K>,
): Promise<MailEffectRecord> {
  return await handlers[kind](scope, effect);
}

function when(appointment: Appointment): string {
  const { date, time } = appointment;
  return `${weekdayName(date)}, ${dateLabel(date)} at ${formatTime12(time)}`;
}

function escalation(
  scope: EffectScope,
  reason: EscalationReason,
  line: string,
  eventId: string | null,
  proposed: Slot | null,
): EffectOf<"escalate"> {
  const { facts } = scope;
  return {
    kind: "escalate",
    reason,
    ...caregiverMessage(facts, line, scope.summary),
    push: facts.receivedAt >= facts.now - DAY_MS,
    eventId,
    proposed,
  };
}

function refusedWrite(
  scope: EffectScope,
  effect: MailEffect,
  error: unknown,
): EffectOf<"escalate"> | null {
  if (!(error instanceof ConvexError)) return null;
  if (effect.kind === "add_event") {
    const { appointment } = effect;
    return escalation(
      scope,
      "unclear_appointment",
      `Sunny could not add ${appointment.title}, ${when(appointment)}, to the calendar.`,
      null,
      null,
    );
  }
  if (effect.kind === "reschedule_event") {
    const event = eventOf(scope, effect.eventId);
    return escalation(
      scope,
      "unclear_reschedule",
      `Sunny could not move ${event.title} to ${when(effect.appointment)}.`,
      effect.eventId,
      { date: effect.appointment.date, time: effect.appointment.time },
    );
  }
  return null;
}

export async function carryOut(
  scope: EffectScope,
  effects: readonly MailEffect[],
): Promise<MailEffectRecord[]> {
  const handlers = makeHandlers(effects);
  const records: MailEffectRecord[] = [];
  for (const effect of effects) {
    try {
      records.push(await runEffect(handlers, scope, effect.kind, effect));
    } catch (e) {
      const fallback = refusedWrite(scope, effect, e);
      if (fallback === null) throw e;
      records.push(await runEffect(handlers, scope, "escalate", fallback));
      return records;
    }
  }
  return records;
}
