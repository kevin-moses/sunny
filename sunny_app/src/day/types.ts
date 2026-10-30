// sunny_app/src/day/types.ts
//
// Purpose: Types for the calendar.dayView query result that both senior surfaces (the phone's
// Today screen and the home display) render, plus the merged agenda line type. The types are
// derived from the backend's generated api (FunctionReturnType), so they follow the server
// and are camelCase exactly as the server sends them. Times are household-local "HH:MM"
// strings and dates are "YYYY-MM-DD"; instants (startsAt, endsAt) are epoch milliseconds.
//
// Last modified: 2026-10-29

import type { FunctionReturnType } from 'convex/server';

import type { api } from '../backend/convexApi';

/** The calendar.dayView result the surfaces render. */
export type DayViewData = FunctionReturnType<typeof api.calendar.dayView>;

/** One of today's task instances (medication, routine, reminder). */
export type DayTask = DayViewData['tasks'][number];

/** One occurrence of a calendar event, in household-local terms. */
export type EventOccurrence = DayViewData['eventsToday'][number];

/** A line in today's agenda: a task or an event, ordered by local time. */
export type AgendaItem =
  | { kind: 'task'; id: string; time: string; task: DayTask }
  | { kind: 'event'; id: string; time: string; event: EventOccurrence };
