// lib/frameFixtures.helpers.ts
// Purpose: Representative device states for the frame renderer's golden tests
// (lib/frame.test.ts), built through the real buildDeviceState (lib/deviceState.ts) from a
// household's day on Saturday 2026-11-07 in New York, so a change to the state's rules shows up
// in the goldens too. Cases: a due medication, nothing due, a missed task ("Nothing to do right
// now."), everything done at night, an empty day, a long label, more rows than fit, an event as
// Next up, an early task (not drawn as Now), an overdue task (the Talk prompt), a snoozed task, a
// multi-step checklist, and a carried-over task with an event earlier than the early one. Test
// helper only (the ".helpers" name keeps it out of the deployed bundle).
//
// Last modified: 2026-11-14

import { buildDeviceState } from "./deviceState";
import type { CueInput, DayEvent, DayTask, DeviceState, DeviceStateInput } from "./deviceState";
import { DEFAULT_SCREEN } from "./frame";
import { MINUTE_MS, zonedInstant } from "./time";

const TZ = "America/New_York";
const DATE = "2026-11-07";

/**
 * purpose: The instant of a New York wall time on the fixture day.
 * @param hhmm: (string) Local "HH:MM".
 * @return: (number) Epoch ms.
 */
export function at(hhmm: string): number {
  return zonedInstant(DATE, hhmm, TZ);
}

/**
 * purpose: A task entry.
 * @param id: (string) Instance id (any text in a fixture).
 * @param time: (string) Local "HH:MM".
 * @param label: (string) Display label.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Other fields.
 * @return: (DayTask) An upcoming routine unless overridden.
 */
function task(
  id: string,
  time: string,
  label: string,
  overrides: Partial<Record<keyof DayTask, unknown>> = {},
): DayTask {
  return {
    instanceId: id,
    localDate: DATE,
    type: "routine",
    displayLabel: label,
    spokenPrompt: `Time for ${label}.`,
    pillDescription: null,
    checklistItems: [],
    scheduledTime: time,
    state: "upcoming",
    carriedOver: false,
    confirmable: false,
    seniorPrompts: 0,
    snoozedUntil: null,
    ...overrides,
  } as DayTask;
}

/**
 * purpose: An event occurrence.
 * @param id: (string) Event id.
 * @param time: (string) Local "HH:MM".
 * @param label: (string) Label.
 * @param visitorName: (string | null) Who visits.
 * @param localDate: (string, optional) Date; default the fixture day.
 * @return: (DayEvent) The occurrence.
 */
function event(
  id: string,
  time: string,
  label: string,
  visitorName: string | null,
  localDate = DATE,
): DayEvent {
  return { eventId: id, label, startTime: time, visitorName, localDate } as DayEvent;
}

/**
 * purpose: The cue input of a task (a window of 60 minutes, no policy steps), so snoozes reach
 *          the state's cues.
 * @param entry: (DayTask) The task.
 * @return: (CueInput) The input.
 */
function cue(entry: DayTask): CueInput {
  const windowStart = at(entry.scheduledTime);
  return {
    entry,
    timing: {
      state: entry.state,
      scheduledTime: entry.scheduledTime,
      windowStart,
      windowEnd: windowStart + 60 * MINUTE_MS,
      createdAt: windowStart - 600 * MINUTE_MS,
      snoozedUntil: entry.snoozedUntil,
      claimedBy: null,
      firedSteps: [],
    },
    steps: [],
  };
}

/**
 * purpose: The device state of a day at a time.
 * @param time: (string) Local "HH:MM" now.
 * @param day: (Partial<DeviceStateInput>) Tasks and events.
 * @return: (DeviceState) The state.
 */
function stateAt(time: string, day: Partial<DeviceStateInput>): DeviceState {
  const tasks = day.tasks ?? [];
  return buildDeviceState(
    {
      seniorPreferredName: "Margaret",
      timezone: TZ,
      tasks,
      eventsToday: day.eventsToday ?? [],
      upcoming: day.upcoming ?? [],
      cueInputs: day.cueInputs ?? tasks.map(cue),
    },
    at(time),
  );
}

/** Morning pills with a pill description. */
const PILLS = { type: "medication", pillDescription: "2 small white pills" } as const;

/**
 * purpose: The usual day: morning pills, a walk, lunch, a visit, evening pills.
 * @param states: (Record<string, string>) Task states by key (am, walk, lunch, pm); default
 *        upcoming.
 * @param am: (Partial<Record<keyof DayTask, unknown>>, optional) More fields of the morning pills.
 * @return: (Partial<DeviceStateInput>) The day.
 */
function usualDay(
  states: Record<string, string>,
  am: Partial<Record<keyof DayTask, unknown>> = {},
): Partial<DeviceStateInput> {
  return {
    tasks: [
      task("pills-am", "08:00", "Morning pills", {
        ...PILLS,
        state: states.am ?? "upcoming",
        ...am,
      }),
      task("walk", "10:00", "Walk around the block", { state: states.walk ?? "upcoming" }),
      task("lunch", "12:30", "Lunch", { type: "reminder", state: states.lunch ?? "upcoming" }),
      task("pills-pm", "18:00", "Evening pills", { ...PILLS, state: states.pm ?? "upcoming" }),
    ],
    eventsToday: [event("visit", "14:00", "Sarah visits", "Sarah")],
  };
}

/** Every golden case: a name for the files and the state. */
export const FRAME_CASES: { name: string; state: DeviceState }[] = [
  { name: "due", state: stateAt("08:10", usualDay({ am: "due" })) },
  {
    name: "nothing-due",
    state: stateAt("11:00", usualDay({ am: "confirmed", walk: "confirmed" })),
  },
  {
    name: "missed",
    state: stateAt(
      "19:30",
      usualDay({ am: "missed", walk: "confirmed", lunch: "confirmed", pm: "confirmed" }),
    ),
  },
  {
    name: "all-done-night",
    state: stateAt(
      "21:30",
      usualDay({ am: "confirmed", walk: "resolved", lunch: "confirmed", pm: "confirmed" }),
    ),
  },
  { name: "empty-day", state: stateAt("09:00", {}) },
  {
    name: "long-label",
    state: stateAt("08:05", {
      tasks: [
        task("bp", "08:00", "Blood pressure tablet with a full glass of water before breakfast", {
          type: "medication",
          state: "due",
          pillDescription:
            "One round pink tablet from the blue box on the kitchen shelf, next to the kettle and the tea",
        }),
        task("call", "11:00", "Call Dr. Abernathy-Whitfield's office about Thursday's appointment"),
      ],
    }),
  },
  {
    name: "many-rows",
    state: stateAt("09:40", {
      tasks: [
        task("t1", "07:00", "Open the curtains", { state: "confirmed" }),
        task("t2", "07:30", "Breakfast", { state: "confirmed" }),
        task("t3", "08:00", "Morning pills", { ...PILLS, state: "confirmed" }),
        task("t4", "09:30", "Water the plants", { state: "due" }),
        task("t5", "11:00", "Crossword"),
        task("t6", "12:30", "Lunch", { type: "reminder" }),
        task("t7", "15:00", "Tea"),
        task("t8", "18:00", "Evening pills", PILLS),
        task("t9", "19:00", "Dinner"),
        task("t10", "21:00", "Lock the front door", { type: "checklist" }),
      ],
      eventsToday: [event("visit", "14:00", "Sarah visits", "Sarah")],
    }),
  },
  {
    name: "event-next",
    state: stateAt("13:00", {
      ...usualDay({ am: "confirmed", walk: "confirmed", lunch: "confirmed" }),
      upcoming: [event("doctor", "09:00", "Dr. Patel", null, "2026-11-08")],
    }),
  },
  {
    name: "early-task",
    state: stateAt("07:30", usualDay({}, { confirmable: true })),
  },
  {
    name: "early-after-event",
    state: stateAt("07:20", {
      tasks: [
        task("pills-am", "08:15", "Morning pills", { ...PILLS, confirmable: true }),
        task("walk", "10:00", "Walk around the block"),
      ],
      eventsToday: [event("nurse", "07:45", "Nurse Joan visits", "Joan")],
    }),
  },
  {
    name: "overdue",
    state: stateAt("08:40", usualDay({ am: "escalated" })),
  },
  {
    name: "snoozed",
    state: stateAt("08:20", {
      tasks: [
        task("pills-am", "08:00", "Morning pills", {
          ...PILLS,
          state: "due",
          snoozedUntil: at("08:35"),
        }),
        task("walk", "10:00", "Walk around the block"),
      ],
    }),
  },
  {
    name: "steps",
    state: stateAt("10:05", {
      tasks: [
        task("pills-am", "08:00", "Morning pills", { ...PILLS, state: "confirmed" }),
        task("out", "10:00", "Getting ready to go out", {
          type: "checklist",
          state: "due",
          checklistItems: ["Put on your coat", "Take your keys", "Lock the door"],
        }),
      ],
    }),
  },
];

/** The screens the goldens are drawn for: the Waveshare panel and a small 1-bit panel. */
export const FRAME_SCREENS = [DEFAULT_SCREEN, { width: 800, height: 480, greys: 2 }];
