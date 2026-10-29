// sunny_app/src/day/types.ts
//
// Purpose: Types for the get_day_view RPC payload that both senior surfaces (the phone's
// Today screen and the home display) render, plus the merged agenda line type. Field
// names stay snake_case exactly as the server sends them; there is no case conversion.
// Times arrive already in the household's local time ("14:00:00", "2026-10-29"). Extra
// keys the server sends are ignored.
//
// Last modified: 2026-10-28

/** One occurrence of a calendar event, in household-local terms. */
export interface EventOccurrence {
  event_id: string;
  label: string;
  /** Local date "YYYY-MM-DD". */
  local_date: string;
  /** Local start time "HH:MM:SS". */
  start_time: string;
  place: string | null;
  visitor_name: string | null;
}

/** One of today's task instances (medication, routine, reminder). */
export interface DayTask {
  instance_id: string;
  display_label: string;
  /** Local time "HH:MM:SS". */
  scheduled_time: string;
  /** Lifecycle state, for example "upcoming", "due", "escalated", "confirmed", "resolved". */
  state: string;
}

/** The get_day_view fields the surfaces render. */
export interface DayViewData {
  local_date: string;
  date_label: string;
  header: string;
  tasks: DayTask[];
  events_today: EventOccurrence[];
  next_up: EventOccurrence | null;
  upcoming: EventOccurrence[];
}

/** A line in today's agenda: a task or an event, ordered by local time. */
export type AgendaItem =
  | { kind: 'task'; id: string; time: string; task: DayTask }
  | { kind: 'event'; id: string; time: string; event: EventOccurrence };
