import type { FunctionReturnType } from 'convex/server';

import type { api } from '../backend/convexApi';

export type DayViewData = FunctionReturnType<typeof api.calendar.dayView>;

export type DayTask = DayViewData['tasks'][number];

export type PlannedTask = DayViewData['upcomingTasks'][number];

export type EventOccurrence = DayViewData['eventsToday'][number];

export type AgendaItem =
  | { kind: 'task'; id: string; time: string; task: DayTask }
  | { kind: 'event'; id: string; time: string; event: EventOccurrence };
