import type { Doc } from "../_generated/dataModel";
import { addDays, isoWeekday, zonedInstant } from "./time";

export interface EventSyncPayload {
  eventId: string;
  cancelled: boolean;
  title: string;
  label: string;
  place: string | null;
  notes: string | null;
  visitorName: string | null;
  seniorPreferredName: string;
  timeZone: string;
  startLocal: string;
  endLocal: string;
  rrule: string | null;
  reminderMinutes: number;
}

export type GoogleEvent = Record<string, unknown>;

const DEFAULT_DURATION_MINUTES = 60;
const FALLBACK_REMINDER_MINUTES = 60;
const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

function minuteOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

function firstOccurrenceDate(startsOn: string, repeatDays: number[] | undefined): string {
  if (!repeatDays || repeatDays.length === 0) return startsOn;
  for (let i = 0; i < 7; i++) {
    const date = addDays(startsOn, i);
    if (repeatDays.includes(isoWeekday(date))) return date;
  }
  return startsOn;
}

function addWallMinutes(date: string, time: string, minutes: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi! + minutes);
  return new Date(wall).toISOString().slice(0, 19);
}

function untilUtc(repeatUntil: string, timeZone: string): string {
  const endOfDay = zonedInstant(addDays(repeatUntil, 1), "00:00", timeZone) - 1000;
  return new Date(endOfDay).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

function buildRrule(event: Doc<"events">, timeZone: string): string | null {
  if (!event.repeatDays || event.repeatDays.length === 0) return null;
  const days = [...event.repeatDays].sort((a, b) => a - b).map((d) => BYDAY[d - 1]);
  const until = event.repeatUntil ? `;UNTIL=${untilUtc(event.repeatUntil, timeZone)}` : "";
  return `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")}${until}`;
}

export function eventSyncPayload(
  event: Doc<"events">,
  household: Doc<"households">,
): EventSyncPayload {
  const first = firstOccurrenceDate(event.startsOn, event.repeatDays);
  const minutes = minuteOfDay(event.startTime) - minuteOfDay(household.eventNoticeTime);
  return {
    eventId: event._id,
    cancelled: event.deletedAt !== undefined,
    title: event.title,
    label: event.label ?? event.title,
    place: event.place ?? null,
    notes: event.notes ?? null,
    visitorName: event.visitorName ?? null,
    seniorPreferredName: household.seniorPreferredName,
    timeZone: household.timezone,
    startLocal: `${first}T${event.startTime}:00`,
    endLocal: addWallMinutes(
      first,
      event.startTime,
      event.durationMinutes ?? DEFAULT_DURATION_MINUTES,
    ),
    rrule: buildRrule(event, household.timezone),
    reminderMinutes: minutes > 0 ? minutes : FALLBACK_REMINDER_MINUTES,
  };
}

export function buildGoogleEvent(p: EventSyncPayload): GoogleEvent {
  const description = [
    p.notes,
    p.visitorName ? `With ${p.visitorName}.` : null,
    p.label !== p.title ? `Shown to ${p.seniorPreferredName} as "${p.label}".` : null,
    "Kept by Sunny: make changes in Sunny, edits here are not synced back yet.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    summary: p.title,
    location: p.place ?? undefined,
    description,
    start: { dateTime: p.startLocal, timeZone: p.timeZone },
    end: { dateTime: p.endLocal, timeZone: p.timeZone },
    recurrence: p.rrule ? [p.rrule] : undefined,
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: p.reminderMinutes }] },
    extendedProperties: { private: { sunny_event_id: p.eventId } },
    status: "confirmed",
  };
}

export function googleEventId(eventId: string): string {
  return Array.from(new TextEncoder().encode(eventId), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}
