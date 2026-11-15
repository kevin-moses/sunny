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
import { ESCALATION_LADDER } from "./escalation";
import type { EscalationStep } from "./escalation";

const TZ = "America/New_York";
const MIN = 60_000;
const NOW = Date.parse("2026-11-07T14:30:00Z");

function local(hhmm: string, date = "2026-11-07"): number {
  return Date.parse(`${date}T${hhmm}:00-05:00`);
}

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

function doneTask(overrides: Partial<Record<keyof DayTask, unknown>> = {}): DayTask {
  return makeTask({ instanceId: "inst1", state: "due", confirmable: true, ...overrides });
}

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

const MEDICATION = ESCALATION_LADDER;

function cueInput(
  entry: Partial<Record<keyof DayTask, unknown>>,
  timing: Partial<CueInput["timing"]> = {},
  steps: readonly EscalationStep[] = MEDICATION,
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
      firedSteps: [],
      ...timing,
    },
    steps,
  };
}

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
      tasks: [makeTask({ state: "confirmed" }), makeTask({ instanceId: "t2", state: "resolved" })],
      eventsToday: [makeEvent({ startTime: "09:00" })],
    });
    expect(state.now).toEqual({ kind: "clear", task: null, allDone: true });
  });

  it("is all done with no tasks and no events", () => {
    expect(stateOf().now).toEqual({ kind: "clear", task: null, allDone: true });
  });

  it("is not all done while a task is missed, even with the rest done", () => {
    const state = stateOf({
      tasks: [
        makeTask({ instanceId: "a", scheduledTime: "07:00", state: "confirmed" }),
        makeTask({ instanceId: "b", state: "missed" }),
      ],
    });
    expect(state.now).toEqual({ kind: "clear", task: null, allDone: false });
  });

  it("is all done again once the missed task is confirmed or resolved", () => {
    for (const state of ["confirmed", "resolved"]) {
      expect(stateOf({ tasks: [makeTask({ state })] }).now).toEqual({
        kind: "clear",
        task: null,
        allDone: true,
      });
    }
  });

  it("still shows a due task over a missed one", () => {
    const state = stateOf({
      tasks: [
        makeTask({ instanceId: "a", state: "missed" }),
        makeTask({ instanceId: "b", scheduledTime: "09:00", state: "due" }),
      ],
    });
    expect(state.now.task?.instanceId).toBe("b");
    expect(state.done).toEqual({ instanceId: "b", early: false });
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
      type: "routine",
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
      type: "event",
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

  it("marks a missed task missed, and done once it is confirmed or resolved", () => {
    const marks = (state: string): string[] =>
      todayRows(buildAgenda([makeTask({ state })], []), null).rows.map((r) => r.mark);
    expect(marks("missed")).toEqual(["missed"]);
    expect(marks("confirmed")).toEqual(["done"]);
    expect(marks("resolved")).toEqual(["done"]);
    expect(marks("upcoming")).toEqual(["none"]);
  });

  it("leaves due, escalated and upcoming tasks unmarked and the Now task now", () => {
    const tasks = [
      makeTask({ instanceId: "a", scheduledTime: "06:00", state: "missed" }),
      makeTask({ instanceId: "b", scheduledTime: "07:00", state: "escalated", carriedOver: true }),
      makeTask({ instanceId: "c", scheduledTime: "08:00", state: "due" }),
      makeTask({ instanceId: "d", scheduledTime: "09:00", state: "upcoming" }),
    ];
    const { rows } = todayRows(buildAgenda(tasks, []), "c");
    expect(rows.map((r) => [r.time, r.mark])).toEqual([
      ["6:00", "missed"],
      ["7:00", "none"],
      ["8:00", "now"],
      ["9:00", "none"],
    ]);
  });

  it("a missed row is not dropped as a done row when rows overflow", () => {
    const tasks = ["06:00", "07:00", "08:00", "09:00"].map((time, i) =>
      makeTask({
        instanceId: `t${i}`,
        scheduledTime: time,
        state: i === 0 ? "missed" : "upcoming",
      }),
    );
    const { rows, hidden } = todayRows(buildAgenda(tasks, []), null, 3);
    expect(rows.map((r) => [r.time, r.mark])).toEqual([
      ["6:00", "missed"],
      ["7:00", "none"],
    ]);
    expect(hidden).toBe(2);
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
            { state: "due", firedSteps: [{ stepId: "prompt" }] },
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
            { state: "due", firedSteps: [{ stepId: "prompt" }] },
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
            { state: "due", firedSteps: [{ stepId: "prompt" }, { stepId: "prompt_again" }] },
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
            { state: "due", createdAt: local("08:20"), firedSteps: [{ stepId: "prompt" }] },
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

describe("the state's shape", () => {
  it("has exactly the allowed keys at every level", () => {
    const state = stateOf({
      tasks: [makeTask({ state: "due", checklistItems: ["Wash", "Dry"] })],
      eventsToday: [makeEvent()],
      upcoming: [makeEvent({ localDate: "2026-11-08" })],
      cueInputs: [cueInput({ state: "due" })],
    });
    const keys = (value: unknown): string[] => Object.keys(value as object).sort();
    expect(keys(state)).toEqual(
      [
        "version",
        "displayVersion",
        "generatedAt",
        "seniorPreferredName",
        "timezone",
        "utcOffsetMinutes",
        "localDate",
        "header",
        "dateLabel",
        "fullDate",
        "now",
        "done",
        "nextUp",
        "nextUpAfterDue",
        "rows",
        "rowsHidden",
        "cues",
        "tuning",
      ].sort(),
    );
    expect(keys(state.now)).toEqual(["allDone", "kind", "task"]);
    expect(keys(state.now.task)).toEqual(
      [
        "instanceId",
        "type",
        "label",
        "time",
        "icon",
        "question",
        "pillDescription",
        "overdue",
        "early",
        "steps",
      ].sort(),
    );
    expect(keys(state.done)).toEqual(["early", "instanceId"]);
    expect(keys(state.nextUp)).toEqual(["icon", "initial", "title", "type", "when"]);
    expect(keys(state.nextUpAfterDue)).toEqual(["icon", "initial", "title", "type", "when"]);
    expect(state.rows.length).toBeGreaterThan(0);
    for (const row of state.rows) {
      expect(keys(row)).toEqual(["key", "label", "mark", "time", "type"]);
    }
    expect(state.cues.length).toBeGreaterThan(0);
    for (const cue of state.cues) {
      expect(keys(cue)).toEqual(
        [
          "instanceId",
          "localDate",
          "speech",
          "cueableNow",
          "seniorPrompts",
          "snoozed",
          "snoozedUntil",
          "promptTimes",
        ].sort(),
      );
    }
    expect(keys(state.tuning)).toEqual(["carousel", "checkAfterMs"]);
    expect(keys(state.tuning.checkAfterMs)).toEqual(["battery", "powered"]);
    expect(keys(state.tuning.carousel)).toEqual(["intervalMs", "pages"]);
  });
});

describe("version", () => {
  const input = makeInput({
    tasks: [makeTask({ state: "due" })],
    eventsToday: [makeEvent()],
    cueInputs: [cueInput({ state: "due" }, { state: "due", firedSteps: [{ stepId: "prompt" }] })],
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
    expect(after.displayVersion).toBe(before.displayVersion);
  });

  it("changes displayVersion with what is drawn, and version with it", () => {
    const base = buildDeviceState(input, NOW);
    const confirmed = buildDeviceState(
      { ...input, tasks: [makeTask({ state: "confirmed" })] },
      NOW,
    );
    expect(base.displayVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(confirmed.rows).not.toEqual(base.rows);
    expect(confirmed.displayVersion).not.toBe(base.displayVersion);
    expect(confirmed.version).not.toBe(base.version);
  });

  it("changes displayVersion when only the count of hidden rows changes", () => {
    const withTasks = (count: number) =>
      stateOf({
        tasks: Array.from({ length: count }, (_, i) =>
          makeTask({ instanceId: `t${i}`, scheduledTime: `${10 + i}:00` }),
        ),
      });
    const nine = withTasks(9);
    const ten = withTasks(10);
    expect(ten.rows).toEqual(nine.rows);
    expect(ten.rowsHidden).toBe(nine.rowsHidden + 1);
    expect(ten.displayVersion).not.toBe(nine.displayVersion);
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

describe("for the wall display", () => {
  const timedEvent = (id: string, hhmm: string, label: string, minutes: number | null): DayEvent =>
    makeEvent({
      eventId: id,
      startTime: hhmm,
      label,
      visitorName: null,
      startsAt: local(hhmm),
      endsAt: minutes === null ? null : local(hhmm) + minutes * MIN,
    });

  it("makes an early Now task itself Next up after due, and leaves a due one out", () => {
    const early = stateOf({
      tasks: [makeTask({ instanceId: "walk", scheduledTime: "10:00", confirmable: true })],
      eventsToday: [makeEvent()],
    });
    expect(early.nextUp?.title).toBe("Sarah visits");
    expect(early.nextUpAfterDue).toMatchObject({ title: "Morning pills", when: "10:00" });
    const due = stateOf({
      tasks: [makeTask({ instanceId: "pills", state: "due" })],
      eventsToday: [makeEvent()],
    });
    expect(due.nextUpAfterDue).toEqual(due.nextUp);
  });

  it("keeps an event before the early task as Next up after due", () => {
    const state = stateOf({
      tasks: [makeTask({ instanceId: "walk", scheduledTime: "10:15", confirmable: true })],
      eventsToday: [timedEvent("nurse", "10:00", "Nurse visits", null)],
    });
    expect(state.nextUpAfterDue?.title).toBe("Nurse visits");
  });

  it("is not fooled by two rows with the same label and clock time", () => {
    const state = stateOf({
      tasks: [makeTask({ instanceId: "walk", scheduledTime: "10:15", confirmable: true })],
      eventsToday: [
        timedEvent("am", "07:10", "Nurse visits", null),
        timedEvent("pm", "19:10", "Nurse visits", null),
      ],
    });
    const twins = state.rows.filter((r) => r.label === "Nurse visits" && r.time === "7:10");
    expect(twins).toHaveLength(2);
    expect(state.nextUp).toMatchObject({ title: "Nurse visits", when: "7:10" });
    expect(state.nextUpAfterDue).toMatchObject({ title: "Morning pills", when: "10:15" });
  });

  it("marks an event past after its end, or an hour after its start without one", () => {
    const state = stateOf({
      eventsToday: [
        timedEvent("ended", "08:00", "Coffee", 60),
        timedEvent("hour", "08:20", "Call", null),
        timedEvent("recent", "08:40", "Mail", null),
        timedEvent("on", "09:00", "Long visit", 120),
        timedEvent("later", "11:00", "Lunch out", null),
      ],
    });
    expect(state.rows.map((r) => [r.label, r.mark, r.type])).toEqual([
      ["Coffee", "past", "event"],
      ["Call", "past", "event"],
      ["Mail", "none", "event"],
      ["Long visit", "none", "event"],
      ["Lunch out", "none", "event"],
    ]);
  });

  it("does not change the Now card or the all-done rule", () => {
    const tasks = [makeTask({ state: "confirmed" })];
    const over = stateOf({ tasks, eventsToday: [timedEvent("e", "08:00", "Coffee", 30)] });
    const without = stateOf({ tasks, eventsToday: [] });
    expect(over.rows.find((r) => r.label === "Coffee")?.mark).toBe("past");
    expect(over.now).toEqual(without.now);
    expect(over.now.allDone).toBe(true);
    const ongoing = stateOf({ tasks, eventsToday: [timedEvent("e", "09:00", "Visit", 120)] });
    expect(ongoing.now).toEqual(without.now);
  });

  it("gives every row and Next up item its type", () => {
    const state = stateOf({
      tasks: [
        makeTask({ type: "medication", state: "due" }),
        makeTask({ instanceId: "t2", type: "reminder", scheduledTime: "11:00" }),
      ],
      eventsToday: [makeEvent()],
    });
    expect(state.rows.map((r) => r.type)).toEqual(["medication", "reminder", "event"]);
    expect(state.nextUp?.type).toBe("reminder");
  });
});
