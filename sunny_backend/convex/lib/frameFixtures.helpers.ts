import { buildDeviceState } from "./deviceState";
import type { CueInput, DayEvent, DayTask, DeviceState, DeviceStateInput } from "./deviceState";
import { DEFAULT_SCREEN } from "./frame";
import { taskStep } from "./taskSteps";
import { MINUTE_MS, zonedInstant } from "./time";

const TZ = "America/New_York";
const DATE = "2026-11-07";

export function at(hhmm: string): number {
  return zonedInstant(DATE, hhmm, TZ);
}

export function fixtureTask(
  id: string,
  time: string,
  label: string,
  overrides: Partial<Record<keyof DayTask, unknown>> = {},
): DayTask {
  const items = (overrides.checklistItems as string[] | undefined) ?? [];
  return {
    instanceId: id,
    localDate: DATE,
    type: "routine",
    displayLabel: label,
    spokenPrompt: `Time for ${label}.`,
    pillDescription: null,
    checklistItems: [],
    step: taskStep(items, 0),
    scheduledTime: time,
    state: "upcoming",
    carriedOver: false,
    confirmable: false,
    seniorPrompts: 0,
    snoozedUntil: null,
    ...overrides,
  } as DayTask;
}

export function fixtureEvent(
  id: string,
  time: string,
  label: string,
  visitorName: string | null,
  localDate = DATE,
  minutes: number | null = null,
): DayEvent {
  const startsAt = zonedInstant(localDate, time, TZ);
  return {
    eventId: id,
    label,
    startTime: time,
    visitorName,
    localDate,
    startsAt,
    endsAt: minutes === null ? null : startsAt + minutes * MINUTE_MS,
  } as DayEvent;
}

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
      firedSteps: [],
    },
    steps: [],
  };
}

export function dayState(time: string, day: Partial<DeviceStateInput>): DeviceState {
  const tasks = day.tasks ?? [];
  return buildDeviceState(
    {
      seniorPreferredName: "Margaret",
      timezone: TZ,
      tasks,
      eventsToday: day.eventsToday ?? [],
      upcoming: day.upcoming ?? [],
      cueInputs: day.cueInputs ?? tasks.map(cue),
      notes: day.notes ?? [],
    },
    at(time),
  );
}

const PILLS = { type: "medication", pillDescription: "2 small white pills" } as const;

function usualDay(
  states: Record<string, string>,
  am: Partial<Record<keyof DayTask, unknown>> = {},
): Partial<DeviceStateInput> {
  return {
    tasks: [
      fixtureTask("pills-am", "08:00", "Morning pills", {
        ...PILLS,
        state: states.am ?? "upcoming",
        ...am,
      }),
      fixtureTask("walk", "10:00", "Walk around the block", { state: states.walk ?? "upcoming" }),
      fixtureTask("lunch", "12:30", "Lunch", {
        type: "reminder",
        state: states.lunch ?? "upcoming",
      }),
      fixtureTask("pills-pm", "18:00", "Evening pills", {
        ...PILLS,
        state: states.pm ?? "upcoming",
      }),
    ],
    eventsToday: [fixtureEvent("visit", "14:00", "Sarah visits", "Sarah")],
  };
}

const GOING_OUT = ["Put on your coat", "Take your keys", "Lock the door"];

export function stepsState(index: number): DeviceState {
  return dayState("10:05", {
    tasks: [
      fixtureTask("pills-am", "08:00", "Morning pills", { ...PILLS, state: "confirmed" }),
      fixtureTask("out", "10:00", "Getting ready to go out", {
        type: "checklist",
        state: "due",
        checklistItems: GOING_OUT,
        step: taskStep(GOING_OUT, index),
      }),
    ],
  });
}

export const FRAME_CASES: { name: string; state: DeviceState }[] = [
  { name: "due", state: dayState("08:10", usualDay({ am: "due" })) },
  {
    name: "nothing-due",
    state: dayState("11:00", usualDay({ am: "confirmed", walk: "confirmed" })),
  },
  {
    name: "missed",
    state: dayState(
      "19:30",
      usualDay({ am: "missed", walk: "confirmed", lunch: "confirmed", pm: "confirmed" }),
    ),
  },
  {
    name: "all-done-night",
    state: dayState(
      "21:30",
      usualDay({ am: "confirmed", walk: "resolved", lunch: "confirmed", pm: "confirmed" }),
    ),
  },
  { name: "empty-day", state: dayState("09:00", {}) },
  {
    name: "long-label",
    state: dayState("08:05", {
      tasks: [
        fixtureTask(
          "bp",
          "08:00",
          "Blood pressure tablet with a full glass of water before breakfast",
          {
            type: "medication",
            state: "due",
            pillDescription:
              "One round pink tablet from the blue box on the kitchen shelf, next to the kettle and the tea",
          },
        ),
        fixtureTask(
          "call",
          "11:00",
          "Call Dr. Abernathy-Whitfield's office about Thursday's appointment",
        ),
      ],
    }),
  },
  {
    name: "many-rows",
    state: dayState("09:40", {
      tasks: [
        fixtureTask("t1", "07:00", "Open the curtains", { state: "confirmed" }),
        fixtureTask("t2", "07:30", "Breakfast", { state: "confirmed" }),
        fixtureTask("t3", "08:00", "Morning pills", { ...PILLS, state: "confirmed" }),
        fixtureTask("t4", "09:30", "Water the plants", { state: "due" }),
        fixtureTask("t5", "11:00", "Crossword"),
        fixtureTask("t6", "12:30", "Lunch", { type: "reminder" }),
        fixtureTask("t7", "15:00", "Tea"),
        fixtureTask("t8", "18:00", "Evening pills", PILLS),
        fixtureTask("t9", "19:00", "Dinner"),
        fixtureTask("t10", "21:00", "Lock the front door", { type: "checklist" }),
      ],
      eventsToday: [fixtureEvent("visit", "14:00", "Sarah visits", "Sarah")],
    }),
  },
  {
    name: "event-next",
    state: dayState("13:00", {
      ...usualDay({ am: "confirmed", walk: "confirmed", lunch: "confirmed" }),
      upcoming: [fixtureEvent("doctor", "09:00", "Dr. Patel", null, "2026-11-08")],
    }),
  },
  {
    name: "early-task",
    state: dayState("07:30", usualDay({}, { confirmable: true })),
  },
  {
    name: "early-after-event",
    state: dayState("07:20", {
      tasks: [
        fixtureTask("pills-am", "08:15", "Morning pills", { ...PILLS, confirmable: true }),
        fixtureTask("walk", "10:00", "Walk around the block"),
      ],
      eventsToday: [fixtureEvent("nurse", "07:45", "Nurse Joan visits", "Joan")],
    }),
  },
  {
    name: "overdue",
    state: dayState("08:40", usualDay({ am: "escalated" })),
  },
  {
    name: "snoozed",
    state: dayState("08:20", {
      tasks: [
        fixtureTask("pills-am", "08:00", "Morning pills", {
          ...PILLS,
          state: "due",
          snoozedUntil: at("08:35"),
        }),
        fixtureTask("walk", "10:00", "Walk around the block"),
      ],
    }),
  },
  { name: "steps", state: stepsState(0) },
  {
    name: "overdue-steps",
    state: dayState("10:40", {
      tasks: [
        fixtureTask("out", "10:00", "Getting ready to go out", {
          type: "checklist",
          state: "escalated",
          checklistItems: GOING_OUT,
        }),
      ],
    }),
  },
  {
    name: "micro-dose",
    state: dayState("08:10", {
      tasks: [
        fixtureTask("b12", "08:00", "Vitamin B12 1000 \u00b5g", {
          type: "medication",
          state: "due",
          pillDescription: "1\u00bd tablets, \u2265 8 oz water",
        }),
        fixtureTask("d", "12:00", "Vitamin D 25 \u03bcg \u2192 with lunch", { type: "medication" }),
      ],
    }),
  },
  {
    name: "blank-label",
    state: dayState("09:10", {
      tasks: [
        fixtureTask("pills", "09:00", "\u{1F48A}\u{1F48A}", { type: "medication", state: "due" }),
        fixtureTask("koji", "11:00", "Call K\u014dji"),
      ],
      eventsToday: [fixtureEvent("breakfast", "10:00", "\u65e9\u9910", null)],
    }),
  },
];

export const FRAME_SCREENS = [DEFAULT_SCREEN, { width: 800, height: 480, greys: 2 }];
