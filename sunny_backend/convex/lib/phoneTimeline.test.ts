import { describe, expect, it } from "vitest";
import { seniorCanConfirm } from "./confirmRule";
import { buildDeviceState, frameDoneTarget } from "./deviceState";
import type { DayEvent, DeviceStateInput } from "./deviceState";
import {
  TIMELINE_HORIZON_MS,
  buildPhoneTimeline,
  cardsAt,
  changeInstants,
  dayAt,
  stateAt,
} from "./phoneTimeline";
import type { PhoneCard, PhoneTimeline, TimelineInput, TimelineTask } from "./phoneTimeline";
import { taskStep } from "./taskSteps";
import { addDays, localDate, localDateTime, zonedInstant } from "./time";
import { shownOn } from "./today";
import type { InstanceState, TaskType } from "./validators";

const TZ = "America/New_York";
const MIN = 60_000;
const DAY = "2026-11-13";
const NEXT = "2026-11-14";

function at(hhmm: string, date = DAY): number {
  return zonedInstant(date, hhmm, TZ);
}

interface TaskSpec {
  date?: string;
  state?: InstanceState;
  windowMinutes?: number;
  items?: string[];
  currentStep?: number;
  type?: TaskType;
  detail?: string | null;
  sentence?: string | null;
  snoozedUntil?: number | null;
}

function task(id: string, label: string, time: string, spec: TaskSpec = {}): TimelineTask {
  const date = spec.date ?? DAY;
  const items = spec.items ?? [];
  const anytime = time === "anytime";
  const windowStart = anytime ? at("00:00", date) : at(time, date);
  const windowEnd = anytime
    ? at("00:00", addDays(date, 1))
    : windowStart + (spec.windowMinutes ?? 60) * MIN;
  return {
    instanceId: id,
    localDate: date,
    type: spec.type ?? "medication",
    displayLabel: label,
    spokenPrompt: `Time for ${label}.`,
    pillDescription: spec.detail ?? null,
    checklistItems: items,
    step: taskStep(items, spec.currentStep),
    scheduledTime: time,
    state: spec.state ?? "upcoming",
    carriedOver: false,
    confirmable: false,
    seniorPrompts: 0,
    snoozedUntil: spec.snoozedUntil ?? null,
    windowStart,
    windowEnd,
    sentence: spec.sentence ?? null,
  } as TimelineTask;
}

function event(id: string, label: string, time: string, date = DAY): DayEvent {
  return {
    eventId: id,
    label,
    startTime: time,
    visitorName: null,
    localDate: date,
    startsAt: at(time, date),
    endsAt: null,
  } as DayEvent;
}

function input(tasks: TimelineTask[], events: DayEvent[] = []): TimelineInput {
  return { timezone: TZ, tasks, events };
}

function stamp(ms: number): string {
  return localDateTime(ms, TZ).slice(5, 16);
}

function describeCard(card: PhoneCard): string {
  if (card.kind === "task") return `${card.label} ${card.step + 1}/${card.stepCount}`;
  const next = card.next === null ? "none" : `${card.next.label} ${stamp(card.next.startsAt)}`;
  return `clear ${card.allDone ? "all done" : "open"}, next ${next}`;
}

function outline(timeline: PhoneTimeline): [string, string[]][] {
  return timeline.entries.map((e) => [stamp(e.at), e.cards.map(describeCard)]);
}

function deviceInputAt(day: TimelineInput, now: number): DeviceStateInput {
  const today = localDate(now, TZ);
  return {
    seniorPreferredName: "Mom",
    timezone: TZ,
    tasks: day.tasks
      .filter((t) => shownOn(t, today))
      .map((t) => ({
        ...t,
        carriedOver: t.localDate !== today,
        confirmable: seniorCanConfirm(t, now),
      })),
    eventsToday: day.events.filter((e) => e.localDate === today),
    upcoming: day.events.filter((e) => e.localDate > today),
    cueInputs: [],
  };
}

function expectFirstCardAgrees(day: TimelineInput, now: number): void {
  const first = buildPhoneTimeline(day, now).entries[0]!.cards[0]!;
  const state = buildDeviceState(deviceInputAt(day, now), now);
  const target = frameDoneTarget(state);
  if (target !== null) {
    expect(first).toMatchObject({ kind: "task", instanceId: target.instanceId, step: target.step });
    return;
  }
  expect(first.kind).toBe("clear");
  if (first.kind !== "clear") return;
  expect(first.allDone).toBe(state.now.kind === "clear" && state.now.allDone);
  expect(first.next?.label ?? null).toBe(state.nextUpAfterDue?.title ?? null);
}

function expectCompleteAndMerged(day: TimelineInput, now: number): void {
  const timeline = buildPhoneTimeline(day, now);
  const { entries } = timeline;
  expect(entries[0]!.at).toBe(now);
  expect(timeline.until).toBe(now + TIMELINE_HORIZON_MS);
  for (let i = 1; i < entries.length; i++) {
    expect(entries[i]!.at).toBeGreaterThan(entries[i - 1]!.at);
    expect(entries[i]!.at).toBeLessThan(timeline.until);
    expect(entries[i]!.cards).not.toEqual(entries[i - 1]!.cards);
  }
  const covering = (t: number) => entries.filter((e) => e.at <= t).at(-1)!.cards;
  const firstMinute = Math.ceil(now / MIN) * MIN;
  for (let t = firstMinute; t < timeline.until; t += MIN) {
    expect(cardsAt(day, t), stamp(t)).toEqual(covering(t));
  }
  expect(cardsAt(day, now)).toEqual(covering(now));
}

type States = Partial<Record<"vitamin" | "pills" | "ready" | "lunch" | "tomorrow", InstanceState>>;

function busyDay(states: States = {}, readyStep = 0): TimelineInput {
  return input(
    [
      task("vitamin", "Vitamin", "06:00", { state: states.vitamin ?? "confirmed" }),
      task("pills", "Morning pills", "08:00", {
        state: states.pills ?? "upcoming",
        detail: "1 white tablet",
        sentence: "Take your morning pills.",
      }),
      task("ready", "Get ready", "09:00", {
        state: states.ready ?? "upcoming",
        type: "routine",
        windowMinutes: 120,
        items: ["Shower", "Dress", "Breakfast"],
        currentStep: readyStep,
      }),
      task("lunch", "Lunch pills", "12:00", { state: states.lunch ?? "upcoming" }),
      task("tomorrow", "Morning pills", "08:00", {
        date: NEXT,
        state: states.tomorrow ?? "upcoming",
      }),
    ],
    [event("sarah", "Sarah visits", "14:00"), event("dentist", "Dentist", "10:00", "2026-11-16")],
  );
}

describe("stateAt (the scheduler's transitions)", () => {
  const pills = task("p", "Pills", "08:00");

  it("keeps an upcoming instance upcoming before its window and makes it due at the start", () => {
    expect(stateAt(pills, at("08:00") - 1)).toBe("upcoming");
    expect(stateAt(pills, at("08:00"))).toBe("due");
    expect(stateAt(pills, at("09:00") - 1)).toBe("due");
  });

  it("makes any open instance missed at the window's end", () => {
    for (const state of ["upcoming", "due", "escalated"] as const) {
      expect(stateAt({ ...pills, state }, at("09:00"))).toBe("missed");
    }
  });

  it("keeps an escalated instance escalated while its window is open", () => {
    expect(stateAt({ ...pills, state: "escalated" }, at("08:45"))).toBe("escalated");
  });

  it("never changes a confirmed, resolved or missed instance", () => {
    for (const state of ["confirmed", "resolved", "missed"] as const) {
      expect(stateAt({ ...pills, state }, at("07:00"))).toBe(state);
      expect(stateAt({ ...pills, state }, at("10:00"))).toBe(state);
    }
  });
});

describe("dayAt (the day the rules see at an instant)", () => {
  it("carries a due instance over midnight and drops it once its window closes", () => {
    const day = input([task("night", "Night pills", "23:30")]);
    const after = dayAt(day, at("00:10", NEXT));
    expect(after.today).toBe(NEXT);
    expect(after.tasks).toMatchObject([{ instanceId: "night", state: "due", carriedOver: true }]);
    expect(dayAt(day, at("00:30", NEXT)).tasks).toEqual([]);
  });

  it("recomputes the early-confirm flag at the instant", () => {
    const day = input([task("p", "Pills", "08:00")]);
    expect(dayAt(day, at("06:59")).tasks[0]!.confirmable).toBe(false);
    expect(dayAt(day, at("07:00")).tasks[0]!.confirmable).toBe(true);
  });

  it("switches today's events and tomorrow's tasks in at midnight", () => {
    const day = busyDay();
    expect(dayAt(day, at("23:59")).tasks.map((t) => t.instanceId)).not.toContain("tomorrow");
    const next = dayAt(day, at("00:00", NEXT));
    expect(next.tasks.map((t) => t.instanceId)).toEqual(["tomorrow"]);
    expect(next.eventsToday).toEqual([]);
    expect(next.upcoming.map((e) => e.eventId)).toEqual(["dentist"]);
  });
});

describe("a day with a done task, a due task, a later task, an event and a multi-step task", () => {
  const morning = busyDay();
  const timeline = buildPhoneTimeline(morning, at("07:00"));

  it("changes at each window start and end, at the event and at midnight", () => {
    expect(outline(timeline)).toEqual([
      ["11-13T07:00", ["clear open, next Morning pills 11-13T08:00"]],
      ["11-13T08:00", ["Morning pills 1/1", "clear open, next Get ready 11-13T09:00"]],
      [
        "11-13T09:00",
        [
          "Get ready 1/3",
          "Get ready 2/3",
          "Get ready 3/3",
          "clear open, next Lunch pills 11-13T12:00",
        ],
      ],
      ["11-13T11:00", ["clear open, next Lunch pills 11-13T12:00"]],
      ["11-13T12:00", ["Lunch pills 1/1", "clear open, next Sarah visits 11-13T14:00"]],
      ["11-13T13:00", ["clear open, next Sarah visits 11-13T14:00"]],
      ["11-13T14:00", ["clear open, next Dentist 11-16T10:00"]],
      ["11-14T00:00", ["clear open, next Morning pills 11-14T08:00"]],
    ]);
  });

  it("fills every field of a task card", () => {
    expect(timeline.entries[1]!.cards[0]).toEqual({
      kind: "task",
      instanceId: "pills",
      step: 0,
      stepCount: 1,
      stepText: null,
      label: "Morning pills",
      sentence: "Take your morning pills.",
      detail: "1 white tablet",
      startsAt: at("08:00"),
      endsAt: at("09:00"),
    });
    expect(timeline.entries[2]!.cards.slice(0, 3)).toMatchObject([
      { instanceId: "ready", step: 0, stepCount: 3, stepText: "Shower", sentence: null },
      { instanceId: "ready", step: 1, stepCount: 3, stepText: "Dress" },
      { instanceId: "ready", step: 2, stepCount: 3, stepText: "Breakfast" },
    ]);
  });

  it("matches a fresh fetch at each boundary, where the scheduler has stored the new states", () => {
    const stored: [number, States][] = [
      [at("08:00"), { pills: "due" }],
      [at("09:00"), { pills: "missed", ready: "due" }],
      [at("11:00"), { pills: "missed", ready: "missed" }],
      [at("12:00"), { pills: "missed", ready: "missed", lunch: "due" }],
      [at("13:00"), { pills: "missed", ready: "missed", lunch: "missed" }],
      [at("14:00"), { pills: "missed", ready: "missed", lunch: "missed" }],
      [at("00:00", NEXT), { pills: "missed", ready: "missed", lunch: "missed" }],
    ];
    expectFirstCardAgrees(morning, at("07:00"));
    for (const [instant, states] of stored) {
      const fresh = busyDay(states);
      expect(cardsAt(morning, instant), stamp(instant)).toEqual(
        buildPhoneTimeline(fresh, instant).entries[0]!.cards,
      );
      expectFirstCardAgrees(fresh, instant);
    }
  });

  it("is complete: every minute of the horizon shows the entry that covers it", () => {
    expectCompleteAndMerged(morning, at("07:00"));
  });

  it("starts a multi-step task at its current step", () => {
    const midway = busyDay({ pills: "missed", ready: "due" }, 1);
    const now = at("09:30");
    expect(buildPhoneTimeline(midway, now).entries[0]!.cards.map(describeCard)).toEqual([
      "Get ready 2/3",
      "Get ready 3/3",
      "clear open, next Lunch pills 11-13T12:00",
    ]);
    expectFirstCardAgrees(midway, now);
  });
});

describe("two tasks due at once", () => {
  it("queues them in the order the Done rule picks them, then the clear card", () => {
    const day = input([
      task("pills", "Morning pills", "08:00", { state: "escalated" }),
      task("drops", "Eye drops", "08:00", { state: "due", type: "routine" }),
      task("walk", "Walk", "10:00", { type: "routine" }),
    ]);
    const now = at("08:40");
    expect(outline(buildPhoneTimeline(day, now))).toEqual([
      ["11-13T08:40", ["Morning pills 1/1", "Eye drops 1/1", "clear open, next Walk 11-13T10:00"]],
      ["11-13T09:00", ["clear open, next Walk 11-13T10:00"]],
      ["11-13T10:00", ["Walk 1/1", "clear open, next none"]],
      ["11-13T11:00", ["clear open, next none"]],
      ["11-14T00:00", ["clear all done, next none"]],
    ]);
    expectFirstCardAgrees(day, now);
    expectCompleteAndMerged(day, now);
  });
});

describe("a window that closes inside the horizon", () => {
  it("leaves a clear card that does not say all done", () => {
    const day = input([task("pills", "Morning pills", "08:00", { state: "due" })]);
    const now = at("08:30");
    expect(outline(buildPhoneTimeline(day, now))).toEqual([
      ["11-13T08:30", ["Morning pills 1/1", "clear all done, next none"]],
      ["11-13T09:00", ["clear open, next none"]],
      ["11-14T00:00", ["clear all done, next none"]],
    ]);
    expectFirstCardAgrees(day, now);
  });
});

describe("a due task carried over midnight", () => {
  const day = input([
    task("night", "Night pills", "23:30"),
    task("tomorrow", "Morning pills", "08:00", { date: NEXT }),
  ]);

  it("stays due after midnight until its window closes", () => {
    const now = at("23:00");
    expect(outline(buildPhoneTimeline(day, now))).toEqual([
      ["11-13T23:00", ["clear open, next Night pills 11-13T23:30"]],
      ["11-13T23:30", ["Night pills 1/1", "clear all done, next none"]],
      ["11-14T00:00", ["Night pills 1/1", "clear open, next Morning pills 11-14T08:00"]],
      ["11-14T00:30", ["clear open, next Morning pills 11-14T08:00"]],
      ["11-14T08:00", ["Morning pills 1/1", "clear all done, next none"]],
      ["11-14T09:00", ["clear open, next none"]],
    ]);
    expectFirstCardAgrees(day, now);
    expectCompleteAndMerged(day, now);
  });

  it("agrees with the device state after midnight, as carried over", () => {
    const stored = input([
      task("night", "Night pills", "23:30", { state: "due" }),
      task("tomorrow", "Morning pills", "08:00", { date: NEXT }),
    ]);
    expectFirstCardAgrees(stored, at("00:10", NEXT));
    expect(buildPhoneTimeline(stored, at("00:10", NEXT)).entries[0]!.cards[0]).toMatchObject({
      instanceId: "night",
      startsAt: at("23:30"),
      endsAt: at("00:30", NEXT),
    });
  });
});

describe("a snoozed task", () => {
  it("is still a task card while snoozed", () => {
    const day = input([
      task("pills", "Morning pills", "08:00", { state: "due", snoozedUntil: at("08:40") }),
    ]);
    const now = at("08:10");
    expect(outline(buildPhoneTimeline(day, now)).slice(0, 2)).toEqual([
      ["11-13T08:10", ["Morning pills 1/1", "clear all done, next none"]],
      ["11-13T09:00", ["clear open, next none"]],
    ]);
    expectFirstCardAgrees(day, now);
  });
});

describe("an anytime task", () => {
  it("is never a task card, keeps the day open, and drops out once missed", () => {
    const day = input([
      task("plants", "Water the plants", "anytime", { state: "due", type: "routine" }),
    ]);
    const now = at("10:00");
    expect(outline(buildPhoneTimeline(day, now))).toEqual([
      ["11-13T10:00", ["clear open, next none"]],
      ["11-14T00:00", ["clear all done, next none"]],
    ]);
    expectFirstCardAgrees(day, now);
    expectCompleteAndMerged(day, now);
  });

  it("is followed by the next day's instance when the task repeats", () => {
    const day = input([
      task("plants", "Water the plants", "anytime", { state: "due", type: "routine" }),
      task("plants2", "Water the plants", "anytime", { date: NEXT, type: "routine" }),
    ]);
    expect(outline(buildPhoneTimeline(day, at("10:00")))).toEqual([
      ["11-13T10:00", ["clear open, next none"]],
    ]);
  });
});

describe("an empty day", () => {
  it("is one clear entry that says all done for the whole horizon", () => {
    const now = at("10:00") + 12_345;
    const timeline = buildPhoneTimeline(input([]), now);
    expect(timeline).toMatchObject({
      generatedAt: now,
      timezone: TZ,
      until: now + 24 * 60 * MIN,
      entries: [{ at: now, cards: [{ kind: "clear", allDone: true, next: null }] }],
    });
    expectFirstCardAgrees(input([]), now);
  });
});

describe("merging", () => {
  it("adds no entry where the cards stay the same", () => {
    const day = busyDay();
    const instants = changeInstants(day, at("06:30"), at("06:30") + TIMELINE_HORIZON_MS);
    expect(instants).toContain(at("07:00"));
    const timeline = buildPhoneTimeline(day, at("06:30"));
    expect(timeline.entries.map((e) => e.at)).not.toContain(at("07:00"));
    expect(timeline.entries[1]!.at).toBe(at("08:00"));
    expectCompleteAndMerged(day, at("06:30"));
  });
});

describe("version", () => {
  it("is stable across generatedAt while the cards and the later changes are the same", () => {
    const day = busyDay();
    const a = buildPhoneTimeline(day, at("07:00"));
    const b = buildPhoneTimeline(day, at("07:20") + 1234);
    expect(b.generatedAt).not.toBe(a.generatedAt);
    expect(b.until).not.toBe(a.until);
    expect(b.version).toBe(a.version);
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the cards change", () => {
    const before = buildPhoneTimeline(busyDay({ pills: "due" }), at("08:10"));
    const after = buildPhoneTimeline(busyDay({ pills: "confirmed" }), at("08:10"));
    expect(after.version).not.toBe(before.version);
  });

  it("changes when only a later change differs", () => {
    const plants = task("plants", "Water the plants", "anytime", { state: "due", type: "routine" });
    const oneDay = buildPhoneTimeline(input([plants]), at("10:00"));
    const twoDays = buildPhoneTimeline(
      input([{ ...plants, windowEnd: at("00:00", "2026-11-15") }]),
      at("10:00"),
    );
    expect(twoDays.entries[0]!.cards).toEqual(oneDay.entries[0]!.cards);
    expect(oneDay.entries).toHaveLength(2);
    expect(twoDays.entries).toHaveLength(1);
    expect(twoDays.version).not.toBe(oneDay.version);
  });
});

describe("daylight saving time", () => {
  const fallBack = "2026-11-01";
  const springForward = "2026-03-08";

  it("follows the event rule through the repeated hour when clocks go back", () => {
    const day = input([], [event("call", "Call", "01:30", fallBack)]);
    const now = Date.parse("2026-11-01T04:00:00Z");
    const timeline = buildPhoneTimeline(day, now);
    expect(timeline.entries.map((e) => [new Date(e.at).toISOString(), e.cards])).toEqual([
      ["2026-11-01T04:00:00.000Z", [clear(false, "Call", at("01:30", fallBack))]],
      ["2026-11-01T05:30:00.000Z", [clear(true, null)]],
      ["2026-11-01T06:00:00.000Z", [clear(false, "Call", at("01:30", fallBack))]],
      ["2026-11-01T06:30:00.000Z", [clear(true, null)]],
    ]);
    expectCompleteAndMerged(day, now);
  });

  it("changes when the clock jumps past an event in the skipped hour", () => {
    const day = input([], [event("call", "Call", "02:30", springForward)]);
    const now = Date.parse("2026-03-08T05:00:00Z");
    const timeline = buildPhoneTimeline(day, now);
    expect(timeline.entries.map((e) => new Date(e.at).toISOString())).toEqual([
      "2026-03-08T05:00:00.000Z",
      "2026-03-08T07:00:00.000Z",
    ]);
    expectCompleteAndMerged(day, now);
  });

  it("finds the next midnight after a 23-hour day", () => {
    const day = input(
      [task("late", "Late pills", "23:30", { date: springForward })],
      [event("call", "Call", "00:15", "2026-03-09")],
    );
    const now = Date.parse("2026-03-08T04:30:00Z");
    const timeline = buildPhoneTimeline(day, now);
    expect(timeline.entries.map((e) => [new Date(e.at).toISOString(), e.cards])).toEqual([
      ["2026-03-08T04:30:00.000Z", [clear(true, "Call", at("00:15", "2026-03-09"))]],
      ["2026-03-08T05:00:00.000Z", [clear(false, "Late pills", at("23:30", springForward))]],
      [
        "2026-03-09T03:30:00.000Z",
        [
          expect.objectContaining({ kind: "task", instanceId: "late" }),
          clear(true, "Call", at("00:15", "2026-03-09")),
        ],
      ],
      [
        "2026-03-09T04:00:00.000Z",
        [
          expect.objectContaining({ kind: "task", instanceId: "late" }),
          clear(false, "Call", at("00:15", "2026-03-09")),
        ],
      ],
      [
        "2026-03-09T04:15:00.000Z",
        [expect.objectContaining({ kind: "task", instanceId: "late" }), clear(true, null)],
      ],
    ]);
    expectCompleteAndMerged(day, now);
  });
});

function clear(allDone: boolean, label: string | null, startsAt = 0): PhoneCard {
  return { kind: "clear", allDone, next: label === null ? null : { label, startsAt } };
}
