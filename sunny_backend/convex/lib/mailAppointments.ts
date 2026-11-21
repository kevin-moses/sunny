import { appointmentTitle } from "./mailTypes";
import type { Appointment, AppointmentRef, CalendarEventFact, Clock } from "./mailTypes";
import { textKey } from "./text";
import { MINUTE_MS, daysBetween, isLocalDate, isLocalTime, localDate, zonedInstant } from "./time";

const MAX_DAYS_AHEAD = 400;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const ASSUMED_DURATION_MINUTES = 30;
const STOP_WORDS = new Set(["the", "and", "for", "with", "appointment", "appt", "visit", "your"]);

declare const DATE_AND_TIME_SHAPED: unique symbol;

export type CheckedAppointment = Appointment & { readonly [DATE_AND_TIME_SHAPED]: true };

export function checked(appointment: Appointment): CheckedAppointment {
  const { date, time } = appointment;
  if (!isLocalDate(date) || !isLocalTime(time)) {
    throw new Error(
      `The verdict gives an appointment at ${date} ${time}, which is not a date and a time`,
    );
  }
  return appointment as CheckedAppointment;
}

export function titleWords(title: string): Set<string> {
  return new Set(
    textKey(title)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

function sharesWords(a: string, b: string): boolean {
  const words = titleWords(a);
  return [...titleWords(b)].some((w) => words.has(w));
}

export function matchEvent(ref: AppointmentRef, events: CalendarEventFact[]): CalendarEventFact[] {
  return events.filter(
    (e) =>
      e.date === ref.date &&
      (ref.time === null || e.time === ref.time) &&
      sharesWords(e.title, appointmentTitle(ref.kind, ref.time)),
  );
}

export function factsCover(date: string, clock: Clock): boolean {
  const today = localDate(clock.now, clock.timezone);
  return date >= today && daysBetween(today, date) <= MAX_DAYS_AHEAD;
}

export function appointmentFields<A extends CheckedAppointment>(
  appointment: A,
  clock: Clock,
): A | null {
  const { date, time, durationMinutes } = appointment;
  if (zonedInstant(date, time, clock.timezone) < clock.now) return null;
  if (!factsCover(date, clock)) return null;
  if (
    durationMinutes !== null &&
    (!Number.isInteger(durationMinutes) ||
      durationMinutes < MIN_DURATION_MINUTES ||
      durationMinutes > MAX_DURATION_MINUTES)
  ) {
    return null;
  }
  return appointment;
}

export function overlaps(a: Appointment, b: CalendarEventFact, timezone: string): boolean {
  const aStart = zonedInstant(a.date, a.time, timezone);
  const bStart = zonedInstant(b.date, b.time, timezone);
  const aEnd = aStart + (a.durationMinutes ?? ASSUMED_DURATION_MINUTES) * MINUTE_MS;
  const bEnd = bStart + (b.durationMinutes ?? ASSUMED_DURATION_MINUTES) * MINUTE_MS;
  return aStart < bEnd && bStart < aEnd;
}
