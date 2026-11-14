// lib/deviceState.test.ts
// Purpose: Unit tests for the device state rules (lib/deviceState.ts), driven through the pure
// buildDeviceState with a fixed clock (Saturday 2026-11-07, 09:30 in New York). Ported from the
// app: the Now card (display/__tests__/model.test.ts nowCard: first due timed task, overdue,
// steps, clear and all done), Next up, the Today rows (marks and overflow), the Done target
// (day/__tests__/useDoneAction.test.tsx doneTarget) and which tasks may cue
// (display/__tests__/cue.test.ts isCueable and the cue cases that do not depend on the device's
// memory of played cues). Added: an early target is shown on the Now card and in done, anytime
// and missed tasks are never targeted, a carried-over task is overdue, promptTimes against a
// policy with prompts at 0 and 15 minutes, a snoozed instance, a task created after its window
// opened, tomorrow's instance inside the 24 hours (and one outside), the header and date lines,
// the null convention, the tuning values, and that version changes when and only when the
// content changes (generatedAt excluded), with the FNV-1a and canonical JSON helpers.
//
// Last modified: 2026-11-13

import { describe, expect, it } from "vitest";
import {
  CUE_HORIZON_MS,
  buildAgenda,
  buildDeviceState,
  canonicalJson,
  doneTarget,
  fnv1a64,
  todayRows,
} from "./deviceState";
import type { CueInput, DayEvent, DayTask, DeviceStateInput } from "./deviceState";
import type { EscalationStep } from "./validators";

const TZ = "America/New_York";
const MIN = 60_000;
/** Saturday 2026-11-07 at 09:30 in New York (UTC-5). */
const NOW = Date.parse("2026-11-07T14:30:00Z");

/**
 * purpose: The instant of a New York wall time on the fixture day (UTC-5).
 * @param hhmm: (string) Local "HH:MM".
 * @param date: (string, optional) Local date; default 2026-11-07.
 * @return: (number) Epoch ms.
 */
function local(hhmm: string, date = "2026-11-07"): number {
  return Date.parse(`${date}T${hhmm}:00-05:00`);
}

/**
 * purpose: Build a task entry.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Fields to set; ids may be plain
 *        strings.
 * @return: (DayTask) An upcoming 08:00 medication, not confirmable, unless overridden.
 */
function makeTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return {
    instanceId: "t1",
    localDate: "2026-11-07",
    type: "medication",
    displayLabel: "Morning pills",
    spokenPrompt: "Time for Morning pills.",
    pillDescription: null,
    checklistItems: [],
    scheduledTime: "08:00",
    state: "upcoming",
    carriedOver: false,
    confirmable: false,
    seniorPrompts: 0,
    snoozedUntil: null,
    ...overrides,
  } as DayTask;
}

/**
 * purpose: Build a task as the phone's doneTarget tests do: due and confirmable by default.
 * @param overrides: (Partial<Record<keyof DayTask, unknown>>) Fields to set.
 * @return: (DayTask) A due, confirmable 08:00 task unless overridden.
 */
function doneTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return makeTask({ instanceId: "inst1", state: "due", confirmable: true, ...overrides });
}

/**
 * purpose: Build an event occurrence on the fixture day.
 * @param overrides: (Partial<Record<keyof DayEvent, unknown>>) Fields to set.
 * @return: (DayEvent) A 14:00 visit by Sarah unless overridden.
 */
function makeEvent(overrides: Partial<Record<keyof DayEvent, unknown>> = {}): DayEvent {
  return {
    eventId: "e1",
    label: "Sarah visits",
    startTime: "14:00",
    visitorName: "Sarah",
    localDate: "2026-11-07",
    ...overrides,
  } as DayEvent;
}

/**
 * purpose: Build the household's day.
 * @param overrides: (Partial<DeviceStateInput>) Fields to set.
 * @return: (DeviceStateInput) An empty day for Margaret in New York unless overridden.
 */
function makeInput(overrides: Partial<DeviceStateInput> = {}): DeviceStateInput {
  return {
    seniorPreferredName: "Margaret",
    timezone: TZ,
    tasks: [],
    eventsToday: [],
    upcoming: [],
    cueInputs: [],
    ...overrides,
  };
}

/** The seeded medication ladder: prompts at 0 and 15 minutes, alerts at 30 and 45. */
const MEDICATION: EscalationStep[] = [
  { id: "p0", offsetMinutes: 0, action: "prompt_senior", skipIfClaimed: false },
  { id: "p15", offsetMinutes: 15, action: "prompt_senior", skipIfClaimed: false },
  { id: "a30", offsetMinutes: 30, action: "alert_on_call", skipIfClaimed: false },
  { id: "a45", offsetMinutes: 45, action: "alert_all_caregivers", skipIfClaimed: true },
];

/**
 * purpose: Build a cue input: an entry with the matching instance timing and policy steps.
 * @param entry: (Partial<Record<keyof DayTask, unknown>>) Entry fields.
 * @param timing: (object) Timing overrides (windowStart, windowEnd, createdAt, snoozedUntil,
 *        claimedBy, firedSteps); the window defaults to the entry's time with 60 minutes.
 * @param steps: (EscalationStep[]) Policy steps; default the medication ladder.
 * @return: (CueInput) The input.
 */
function cueInput(
  entry: Partial<Record<keyof DayTask, unknown>>,
  timing: Partial<CueInput["timing"]> = {},
  steps: EscalationStep[] = MEDICATION,
): CueInput {
  const task = makeTask(entry);
  const windowStart = local(task.scheduledTime, task.localDate);
  return {
    entry: task,
    timing: {
      state: task.state,
      scheduledTime: task.scheduledTime,
      windowStart,
      windowEnd: windowStart + 60 * MIN,
      createdAt: windowStart - 600 * MIN,
      snoozedUntil: task.snoozedUntil,
      claimedBy: null,
      firedSteps: [],
      ...timing,
    },
    steps,
  };
}

/**
 * purpose: Build the state at NOW (or another instant).
 * @param overrides: (Partial<DeviceStateInput>) Input fields.
 * @param now: (number, optional) Epoch ms; default NOW.
 * @return: The device state.
 */
function stateOf(overrides: Partial<DeviceStateInput> = {}, now = NOW) {
  return buildDeviceState(makeInput(overrides), now);
}

describe("header, dates and conventions", () => {
  it("names the day and part of day in the household's zone", () => {
    const state = stateOf();
    expect(state).toMatchObject({
      seniorPreferredName: "Margaret",
      timezone: TZ,
      utcOffsetMinutes: -300,
      localDate: "2026-11-07",
      header: "Saturday morning",
      dateLabel: "November 7",
      fullDate: "November 7, 2026",
      generatedAt: NOW,
    });
  });

  it("uses the summer offset in summer", () => {
    expect(stateOf({}, Date.parse("2026-07-01T12:00:00Z")).utcOffsetMinutes).toBe(-240);
  });

  it("uses null for absent values, never a missing key", () => {
    const state = stateOf();
    expect(state.done).toBeNull();
    expect(state.nextUp).toBeNull();
    expect(state.now).toEqual({ kind: "clear", task: null, allDone: true });
    expect(Object.values(state).includes(undefined)).toBe(false);
  });

  it("carries the tuning values", () => {
    expect(stateOf().tuning).toEqual({
      checkAfterMs: { powered: 20_000, battery: 120_000 },
      carousel: { pages: ["now", "today"], intervalMs: 45_000 },
    });
  });
});

describe("done (the phone's doneTarget)", () => {
  it("picks the first due task", () => {
    const first = doneTask({ instanceId: "a" });
    const done = doneTask({ instanceId: "x", state: "confirmed", confirmable: false });
    expect(doneTarget([done, first, doneTask({ instanceId: "b" })])).toBe(first);
  });

  it("picks an escalated task", () => {
    const late = doneTask({ state: "escalated" });
    expect(doneTarget([late])).toBe(late);
  });

  it("prefers a due task over an earlier-listed confirmable upcoming one", () => {
    const early = doneTask({ instanceId: "e", state: "upcoming" });
    const due = doneTask({ instanceId: "d" });
    expect(doneTarget([early, due])).toBe(due);
  });

  it("otherwise picks the first confirmable upcoming task", () => {
    const tooEarly = doneTask({ instanceId: "t", state: "upcoming", confirmable: false });
    const early = doneTask({ instanceId: "e", state: "upcoming" });
    expect(doneTarget([tooEarly, early, doneTask({ instanceId: "f", state: "upcoming" })])).toBe(
      early,
    );
  });

  it("is null when nothing may be confirmed", () => {
    expect(
      doneTarget([
        doneTask({ state: "upcoming", confirmable: false }),
        doneTask({ state: "missed" }),
        doneTask({ state: "confirmed", confirmable: false }),
      ]),
    ).toBeNull();
    expect(doneTarget([])).toBeNull();
  });

  it("never targets an anytime task", () => {
    expect(doneTarget([doneTask({ scheduledTime: "anytime" })])).toBeNull();
    expect(doneTarget([doneTask({ scheduledTime: "anytime", state: "upcoming" })])).toBeNull();
  });

  it("never targets a missed task, even a confirmable one", () => {
    expect(doneTarget([doneTask({ state: "missed", confirmable: true })])).toBeNull();
  });

  it("marks an early target and shows it on the Now card", () => {
    const state = stateOf({
      tasks: [
        makeTask({
          instanceId: "walk",
          type: "routine",
          scheduledTime: "10:00",
          confirmable: true,
        }),
      ],
    });
    expect(state.done).toEqual({ instanceId: "walk", early: true });
    expect(state.now.kind).toBe("task");
    expect(state.now.task).toMatchObject({
      instanceId: "walk",
      early: true,
      overdue: false,
      time: "10:00",
      question: "Finished?",
      icon: "clock",
    });
    expect(state.rows.map((r) => r.mark)).toEqual(["now"]);
  });

  it("a due target is not early", () => {
    const state = stateOf({ tasks: [makeTask({ state: "due", confirmable: true })] });
    expect(state.done).toEqual({ instanceId: "t1", early: false });
    expect(state.now.task?.early).toBe(false);
  });
});

describe("now (the Now card)", () => {
  it("shows the first due timed task, skipping anytime tasks", () => {
    const state = stateOf({
      tasks: [
        makeTask({ instanceId: "plants", scheduledTime: "anytime", state: "due" }),
        makeTask({ instanceId: "pills", state: "due" }),
        makeTask({ instanceId: "walk", scheduledTime: "10:00", state: "due" }),
      ],
    });
    expect(state.now.task?.instanceId).toBe("pills");
    expect(state.now.task).toMatchObject({
      label: "Morning pills",
      time: "8:00",
      icon: "pills",
      question: "Taken them?",
      pillDescription: null,
    });
  });

  it("marks escalated and carried-over tasks as overdue", () => {
    const escalated = stateOf({ tasks: [makeTask({ state: "escalated" })] });
    const carried = stateOf({
      tasks: [makeTask({ state: "due", carriedOver: true, localDate: "2026-11-06" })],
    });
    const due = stateOf({ tasks: [makeTask({ state: "due" })] });
    expect(escalated.now.task?.overdue).toBe(true);
    expect(carried.now.task?.overdue).toBe(true);
    expect(due.now.task?.overdue).toBe(false);
  });

  it("uses two or more checklist items as steps", () => {
    const steps = ["Wash your hands", "Tilt your head back"];
    const multi = stateOf({ tasks: [makeTask({ state: "due", checklistItems: steps })] });
    const single = stateOf({ tasks: [makeTask({ state: "due", checklistItems: ["Only one"] })] });
    expect(multi.now.task?.steps).toEqual(steps);
    expect(single.now.task?.steps).toBeNull();
  });

  it("is clear but not all done while a task or event is still ahead", () => {
    expect(stateOf({ tasks: [makeTask()] }).now).toEqual({
      kind: "clear",
      task: null,
      allDone: false,
    });
    expect(stateOf({ eventsToday: [makeEvent()] }).now).toEqual({
      kind: "clear",
      task: null,
      allDone: false,
    });
  });

  it("is all done when every task is finished and no event is ahead", () => {
    const state = stateOf({
      tasks: [makeTask({ state: "confirmed" }), makeTask({ instanceId: "t2", state: "missed" })],
      eventsToday: [makeEvent({ startTime: "09:00" })],
    });
    expect(state.now).toEqual({ kind: "clear", task: null, allDone: true });
  });
});

describe("nextUp", () => {
  it("picks the first later task, skipping the Now task, done and anytime tasks", () => {
    const state = stateOf({
      tasks: [
        makeTask({ instanceId: "pills", state: "due" }),
        makeTask({ instanceId: "breakfast", scheduledTime: "07:30", state: "confirmed" }),
        makeTask({ instanceId: "plants", scheduledTime: "anytime", state: "due" }),
        makeTask({
          instanceId: "walk",
          type: "routine",
          displayLabel: "Morning walk",
          scheduledTime: "10:00",
        }),
      ],
      eventsToday: [makeEvent()],
    });
    expect(state.nextUp).toEqual({
      title: "Morning walk",
      when: "10:00",
      icon: "clock",
      initial: null,
    });
  });

  it("skips an early Now task too", () => {
    const state = stateOf({
      tasks: [makeTask({ instanceId: "walk", scheduledTime: "10:00", confirmable: true })],
      eventsToday: [makeEvent()],
    });
    expect(state.nextUp?.title).toBe("Sarah visits");
  });

  it("shows a later event with the visitor's initial and skips events already started", () => {
    const state = stateOf({
      eventsToday: [makeEvent({ eventId: "early", startTime: "09:00" }), makeEvent()],
    });
    expect(state.nextUp).toEqual({
      title: "Sarah visits",
      when: "2:00",
      icon: "calendar",
      initial: "S",
    });
  });

  it("falls back to the next event on a later day", () => {
    const tomorrow = makeEvent({
      label: "Church",
      visitorName: null,
      localDate: "2026-11-08",
      startTime: "09:00",
    });
    const later = makeEvent({ label: "Doctor", visitorName: null, localDate: "2026-11-10" });
    expect(stateOf({ upcoming: [tomorrow] }).nextUp?.when).toBe("Tomorrow, 9:00");
    expect(stateOf({ upcoming: [later] }).nextUp?.when).toBe("Tuesday, 2:00");
    expect(stateOf().nextUp).toBeNull();
  });
});

describe("rows (the Today page)", () => {
  it("marks done tasks and the Now task", () => {
    const state = stateOf({
      tasks: [
        makeTask({ instanceId: "breakfast", scheduledTime: "07:30", state: "confirmed" }),
        makeTask({ instanceId: "pills", state: "due" }),
      ],
      eventsToday: [makeEvent()],
    });
    expect(state.rows.map((r) => [r.time, r.mark])).toEqual([
      ["7:30", "done"],
      ["8:00", "now"],
      ["2:00", "none"],
    ]);
    expect(state.rows.map((r) => r.key)).toEqual([
      "task-breakfast",
      "task-pills",
      "event-e1-2026-11-07",
    ]);
    expect(state.rowsHidden).toBe(0);
  });

  it("lists anytime tasks last and keeps tasks before events at the same time", () => {
    const agenda = buildAgenda(
      [
        makeTask({ instanceId: "any", scheduledTime: "anytime" }),
        makeTask({ instanceId: "nine", scheduledTime: "09:00" }),
      ],
      [makeEvent({ eventId: "e9", startTime: "09:00" })],
    );
    expect(agenda.map((a) => a.id)).toEqual(["task-nine", "event-e9-2026-11-07", "task-any"]);
  });

  it("drops the earliest done rows first, then counts the latest rows left out", () => {
    const tasks = ["06:00", "07:00", "08:00", "09:00", "10:00", "11:00"].map((time, i) =>
      makeTask({
        instanceId: `t${i}`,
        scheduledTime: time,
        state: i < 2 ? "confirmed" : "upcoming",
      }),
    );
    const agenda = buildAgenda(tasks, []);
    expect(todayRows(agenda, null, 4).rows.map((r) => r.time)).toEqual([
      "8:00",
      "9:00",
      "10:00",
      "11:00",
    ]);
    const tight = todayRows(agenda, null, 3);
    expect(tight.rows.map((r) => r.time)).toEqual(["8:00", "9:00"]);
    expect(tight.hidden).toBe(2);
  });

  it("fits seven rows on the page", () => {
    const tasks = Array.from({ length: 9 }, (_, i) =>
      makeTask({ instanceId: `t${i}`, scheduledTime: `1${i}:00` }),
    );
    const state = stateOf({ tasks });
    expect(state.rows).toHaveLength(6);
    expect(state.rowsHidden).toBe(3);
  });
});

describe("cues", () => {
  it("cues a due task now, with the display's sentence", () => {
    const [cue] = stateOf({ cueInputs: [cueInput({ state: "due", seniorPrompts: 1 })] }).cues;
    expect(cue).toEqual({
      instanceId: "t1",
      localDate: "2026-11-07",
      speech: "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.",
      cueableNow: true,
      seniorPrompts: 1,
      snoozed: false,
      snoozedUntil: null,
      promptTimes: [],
    });
  });

  it("cues an escalated task the same way and keeps the day order", () => {
    const cues = stateOf({
      cueInputs: [
        cueInput({ instanceId: "a", state: "escalated" }),
        cueInput({ instanceId: "b", state: "due" }),
      ],
    }).cues;
    expect(cues.map((c) => [c.instanceId, c.cueableNow])).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });

  it("never cues finished, missed or anytime tasks", () => {
    const cues = stateOf({
      cueInputs: [
        cueInput({ instanceId: "c", state: "confirmed" }),
        cueInput({ instanceId: "r", state: "resolved" }),
        cueInput({ instanceId: "m", state: "missed" }),
        cueInput({ instanceId: "any", state: "due", scheduledTime: "anytime" }),
      ],
    }).cues;
    expect(cues).toEqual([]);
  });

  it("lists an upcoming task only when the policy will prompt for it, never as cueable now", () => {
    const at = local("07:00");
    const withPolicy = stateOf({ cueInputs: [cueInput({})] }, at).cues;
    expect(withPolicy).toHaveLength(1);
    expect(withPolicy[0]!.cueableNow).toBe(false);
    expect(stateOf({ cueInputs: [cueInput({}, {}, [])] }, at).cues).toEqual([]);
  });

  it("lists the prompt instants of a policy with prompts at 0 and 15 minutes", () => {
    const before = stateOf({ cueInputs: [cueInput({})] }, local("07:00")).cues[0]!;
    expect(before.promptTimes).toEqual([local("08:00"), local("08:15")]);
    const after = stateOf(
      {
        cueInputs: [
          cueInput(
            { state: "due", seniorPrompts: 1 },
            { state: "due", firedSteps: [{ stepId: "p0" }] },
          ),
        ],
      },
      local("08:05"),
    ).cues[0]!;
    expect(after.promptTimes).toEqual([local("08:15")]);
    expect(after.cueableNow).toBe(true);
  });

  it("holds a snoozed instance and moves its prompts to the snooze end", () => {
    const snoozedUntil = local("08:30");
    const cue = stateOf(
      {
        cueInputs: [
          cueInput(
            { state: "due", snoozedUntil, seniorPrompts: 1 },
            { state: "due", firedSteps: [{ stepId: "p0" }] },
          ),
        ],
      },
      local("08:10"),
    ).cues[0]!;
    expect(cue).toMatchObject({
      cueableNow: false,
      snoozed: true,
      snoozedUntil,
      promptTimes: [snoozedUntil],
    });
    const ended = stateOf(
      {
        cueInputs: [
          cueInput(
            { state: "due", snoozedUntil, seniorPrompts: 2 },
            { state: "due", firedSteps: [{ stepId: "p0" }, { stepId: "p15" }] },
          ),
        ],
      },
      local("08:31"),
    ).cues[0]!;
    expect(ended).toMatchObject({ cueableNow: true, snoozed: false, snoozedUntil });
  });

  it("counts a task created after its window opened from its creation", () => {
    const cue = stateOf(
      {
        cueInputs: [
          cueInput(
            { state: "due", seniorPrompts: 1 },
            { state: "due", createdAt: local("08:20"), firedSteps: [{ stepId: "p0" }] },
          ),
        ],
      },
      local("08:21"),
    ).cues[0]!;
    expect(cue.promptTimes).toEqual([local("08:35")]);
  });

  it("includes tomorrow's instance inside the 24 hours and leaves out a later one", () => {
    const now = local("20:00");
    const cues = stateOf(
      {
        cueInputs: [
          cueInput({ instanceId: "morning", localDate: "2026-11-08", scheduledTime: "08:00" }),
          cueInput({ instanceId: "late", localDate: "2026-11-08", scheduledTime: "21:00" }),
        ],
      },
      now,
    ).cues;
    expect(cues.map((c) => c.instanceId)).toEqual(["morning"]);
    expect(cues[0]!.localDate).toBe("2026-11-08");
    expect(cues[0]!.promptTimes).toEqual([
      local("08:00", "2026-11-08"),
      local("08:15", "2026-11-08"),
    ]);
    expect(cues[0]!.promptTimes.every((t) => t <= now + CUE_HORIZON_MS)).toBe(true);
  });
});

describe("version", () => {
  const input = makeInput({
    tasks: [makeTask({ state: "due" })],
    eventsToday: [makeEvent()],
    cueInputs: [cueInput({ state: "due" }, { state: "due", firedSteps: [{ stepId: "p0" }] })],
  });

  it("is 16 hex characters and the same for the same content", () => {
    const a = buildDeviceState(input, NOW);
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(buildDeviceState(input, NOW).version).toBe(a.version);
  });

  it("does not change with generatedAt alone", () => {
    const a = buildDeviceState(input, NOW);
    const b = buildDeviceState(input, NOW + 20_000);
    expect(b.generatedAt).not.toBe(a.generatedAt);
    expect(b.version).toBe(a.version);
  });

  it("changes when the content changes", () => {
    const base = buildDeviceState(input, NOW).version;
    const confirmed = buildDeviceState(
      { ...input, tasks: [makeTask({ state: "confirmed" })] },
      NOW,
    ).version;
    const renamed = buildDeviceState(
      { ...input, tasks: [makeTask({ state: "due", displayLabel: "Pills" })] },
      NOW,
    ).version;
    const laterHeader = buildDeviceState(input, local("12:30")).version;
    expect(new Set([base, confirmed, renamed, laterHeader]).size).toBe(4);
  });

  it("changes when a prompt instant passes", () => {
    const before = buildDeviceState(input, local("08:14"));
    const after = buildDeviceState(input, local("08:16"));
    expect(before.cues[0]!.promptTimes).toEqual([local("08:15")]);
    expect(after.cues[0]!.promptTimes).toEqual([]);
    expect(after.version).not.toBe(before.version);
  });

  it("hashes canonical JSON (key order does not matter) with FNV-1a 64", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe(
      '{"a":[{"c":"x","d":null}],"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });
});
