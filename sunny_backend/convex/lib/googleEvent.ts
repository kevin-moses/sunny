// lib/googleEvent.ts
// Purpose: Pure mapping from a Sunny event to a Google Calendar event, with no I/O. Ports
// the SQL function get_event_sync_payload (local start and end in the household timezone,
// the default one-hour duration, a weekly RRULE whose DTSTART is moved to the first
// matching weekday and whose UNTIL is the end of the last local day in UTC, and the popup
// reminder that lands on the household's event notice time) and the Deno buildGoogleEvent.
// googleEventId derives a Google-valid event id from a Convex id so a retried create can
// never duplicate an event.
// Exports: EventSyncPayload, GoogleEvent, eventSyncPayload, buildGoogleEvent, googleEventId.
//
// Last modified: 2026-10-29

import type { Doc } from "../_generated/dataModel";
import { addDays, isoWeekday, zonedInstant } from "./time";

/** An event in Google's terms; cancelled events carry the same fields and are deleted. */
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

/** A Google Calendar event resource body. */
export type GoogleEvent = Record<string, unknown>;

const DEFAULT_DURATION_MINUTES = 60;
const FALLBACK_REMINDER_MINUTES = 60;
const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * purpose: Minutes since midnight of an "HH:MM" time.
 * @param time: (string) Local "HH:MM".
 * @return: (number) Minutes from 00:00.
 */
function minuteOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

/**
 * purpose: The first date on or after startsOn (within 7 days) whose ISO weekday is in
 *          the repeat days; the one-off date itself when there is no repeat.
 * @param startsOn: (string) Local "YYYY-MM-DD".
 * @param repeatDays: (number[] | undefined) ISO weekdays of the repeat.
 * @return: (string) Local "YYYY-MM-DD" of the first occurrence.
 */
function firstOccurrenceDate(startsOn: string, repeatDays: number[] | undefined): string {
  if (!repeatDays || repeatDays.length === 0) return startsOn;
  for (let i = 0; i < 7; i++) {
    const date = addDays(startsOn, i);
    if (repeatDays.includes(isoWeekday(date))) return date;
  }
  return startsOn;
}

/**
 * purpose: Add minutes to a local date and time as plain wall-clock arithmetic (no DST),
 *          matching the SQL timestamp + interval.
 * @param date: (string) Local "YYYY-MM-DD".
 * @param time: (string) Local "HH:MM".
 * @param minutes: (number) Minutes to add.
 * @return: (string) "YYYY-MM-DDTHH:MM:SS".
 */
function addWallMinutes(date: string, time: string, minutes: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi! + minutes);
  return new Date(wall).toISOString().slice(0, 19);
}

/**
 * purpose: The RRULE UNTIL value: the last second of the final local day, in UTC.
 * @param repeatUntil: (string) Last local date "YYYY-MM-DD".
 * @param timeZone: (string) Household IANA zone.
 * @return: (string) "YYYYMMDDTHHMMSSZ".
 */
function untilUtc(repeatUntil: string, timeZone: string): string {
  const endOfDay = zonedInstant(addDays(repeatUntil, 1), "00:00", timeZone) - 1000;
  return new Date(endOfDay).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

/**
 * purpose: Build the weekly RRULE for an event, or null for a one-off.
 * @param event: (Doc<"events">) The event.
 * @param timeZone: (string) Household IANA zone.
 * @return: (string | null) "RRULE:FREQ=WEEKLY;BYDAY=...[;UNTIL=...]" or null.
 */
function buildRrule(event: Doc<"events">, timeZone: string): string | null {
  if (!event.repeatDays || event.repeatDays.length === 0) return null;
  const days = [...event.repeatDays].sort((a, b) => a - b).map((d) => BYDAY[d - 1]);
  const until = event.repeatUntil ? `;UNTIL=${untilUtc(event.repeatUntil, timeZone)}` : "";
  return `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")}${until}`;
}

/**
 * purpose: The event in Google's terms; an exact port of get_event_sync_payload. The
 *          reminder fires at the household's event notice time on the day, or an hour
 *          ahead when the event starts at or before that time.
 * @param event: (Doc<"events">) The Sunny event.
 * @param household: (Doc<"households">) Its household (timezone, notice time, name).
 * @return: (EventSyncPayload) Payload for buildGoogleEvent.
 */
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

/**
 * purpose: Map a sync payload to a Google Calendar event resource: local times in the
 *          household timezone, the weekly RRULE, a popup reminder, and Sunny's event id in
 *          private extended properties.
 * @param p: (EventSyncPayload) Result of eventSyncPayload.
 * @return: (GoogleEvent) Google event body.
 */
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
    // Restores the event if it was deleted in Google (deleted ids stay reserved there).
    status: "confirmed",
  };
}

/**
 * purpose: The Google event id for a Sunny event. Google accepts 5-1024 characters of
 *          base32hex (0-9, a-v). Convex ids use letters past v, so the id is hex-encoded
 *          (UTF-8 bytes, two hex digits each), which is injective, deterministic and
 *          always base32hex-safe.
 * @param eventId: (string) Convex events id.
 * @return: (string) Google event id.
 */
export function googleEventId(eventId: string): string {
  return Array.from(new TextEncoder().encode(eventId), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}
