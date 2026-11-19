import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { EARLY_CONFIRM_MS, seniorCanConfirm } from "./confirmRule";
import {
  buildAgenda,
  canonicalJson,
  doneTarget,
  fnv1a64,
  instanceDayTask,
  isDue,
  loadDeviceDay,
  nowCard,
  pickNext,
} from "./deviceState";
import type { DayEvent, DayTask, DeviceDay } from "./deviceState";
import { isOpenState } from "./escalation";
import { stepIndex } from "./taskSteps";
import type { TaskStep } from "./taskSteps";
import {
  DAY_MS,
  addDays,
  localDate,
  localTime,
  offsetAt,
  offsetChanges,
  wallClockMs,
} from "./time";
import { shownOn } from "./today";
import type { InstanceState } from "./validators";

export const TIMELINE_HORIZON_MS = DAY_MS;

export interface TimelineTask extends DayTask {
  windowStart: number;
  windowEnd: number;
  sentence: string | null;
}

export interface TimelineInput {
  timezone: string;
  tasks: TimelineTask[];
  events: DayEvent[];
}

export interface DayAt {
  today: string;
  time: string;
  tasks: TimelineTask[];
  eventsToday: DayEvent[];
  upcoming: DayEvent[];
}

export interface PhoneTaskCard {
  kind: "task";
  instanceId: Id<"taskInstances">;
  step: number;
  stepCount: number;
  stepText: string | null;
  label: string;
  sentence: string | null;
  detail: string | null;
  startsAt: number;
  endsAt: number;
}

export interface PhoneClearCard {
  kind: "clear";
  allDone: boolean;
  next: { label: string; startsAt: number } | null;
}

export type PhoneCard = PhoneTaskCard | PhoneClearCard;

export interface TimelineEntry {
  at: number;
  cards: PhoneCard[];
}

export interface PhoneTimeline {
  version: string;
  generatedAt: number;
  timezone: string;
  until: number;
  entries: TimelineEntry[];
}

export function timelineInput(day: DeviceDay, now: number): TimelineInput {
  return {
    timezone: day.timezone,
    tasks: day.instances.map(({ instance, task }) => ({
      ...instanceDayTask(instance, task, now),
      windowStart: instance.windowStart,
      windowEnd: instance.windowEnd,
      sentence: task.screenSentence ?? null,
    })),
    events: day.events,
  };
}

export function stateAt(
  task: Pick<TimelineTask, "state" | "windowStart" | "windowEnd">,
  at: number,
): InstanceState {
  if (!isOpenState(task.state)) return task.state;
  if (at >= task.windowEnd) return "missed";
  if (task.state === "upcoming" && at >= task.windowStart) return "due";
  return task.state;
}

export function dayAt(input: TimelineInput, at: number): DayAt {
  const today = localDate(at, input.timezone);
  const tasks = input.tasks.flatMap((task): TimelineTask[] => {
    const state = stateAt(task, at);
    if (!shownOn({ localDate: task.localDate, state }, today)) return [];
    return [
      {
        ...task,
        state,
        carriedOver: task.localDate !== today,
        confirmable: seniorCanConfirm({ state, windowStart: task.windowStart }, at),
      },
    ];
  });
  return {
    today,
    time: localTime(at, input.timezone),
    tasks,
    eventsToday: input.events.filter((e) => e.localDate === today),
    upcoming: input.events.filter((e) => e.localDate > today),
  };
}

function stepsLeft(task: DayTask): (TaskStep | null)[] {
  const { step } = task;
  if (step === null) return [null];
  return task.checklistItems
    .slice(step.index)
    .map((text, n) => ({ index: step.index + n, count: step.count, text }));
}

function taskCards(task: TimelineTask): PhoneTaskCard[] {
  return stepsLeft(task).map((step) => ({
    kind: "task",
    instanceId: task.instanceId,
    step: stepIndex(step),
    stepCount: step?.count ?? 1,
    stepText: step?.text ?? null,
    label: task.displayLabel,
    sentence: task.sentence,
    detail: task.pillDescription,
    startsAt: task.windowStart,
    endsAt: task.windowEnd,
  }));
}

function confirmed<T extends DayTask>(task: T): T {
  return { ...task, state: "confirmed", confirmable: false };
}

function clearCard(day: DayAt, tasks: TimelineTask[]): PhoneClearCard {
  const { allDone } = nowCard(tasks, doneTarget(tasks), day.eventsToday, day.time);
  const agenda = buildAgenda(tasks, day.eventsToday);
  const next = pickNext(agenda, day.upcoming, day.today, day.time, null);
  if (next === null) return { kind: "clear", allDone, next: null };
  return {
    kind: "clear",
    allDone,
    next:
      next.kind === "task"
        ? { label: next.task.displayLabel, startsAt: next.task.windowStart }
        : { label: next.event.label, startsAt: next.event.startsAt },
  };
}

export function cardsAt(input: TimelineInput, at: number): PhoneCard[] {
  const day = dayAt(input, at);
  let tasks = day.tasks;
  const cards: PhoneCard[] = [];
  let target = doneTarget(tasks);
  while (target !== null && isDue(target)) {
    cards.push(...taskCards(target));
    const pressed = target;
    tasks = tasks.map((t) => (t === pressed ? confirmed(t) : t));
    target = doneTarget(tasks);
  }
  cards.push(clearCard(day, tasks));
  return cards;
}

function localDates(from: number, until: number, timezone: string): string[] {
  const last = localDate(until, timezone);
  const dates: string[] = [];
  for (let date = localDate(from, timezone); date <= last; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

export function changeInstants(input: TimelineInput, from: number, until: number): number[] {
  const { timezone } = input;
  const offsetShifts = offsetChanges(from, until, timezone);
  const offsets = new Set([from, ...offsetShifts].map((at) => offsetAt(at, timezone)));
  const dates = localDates(from, until, timezone);
  const wallTimes = [
    ...dates.map((date) => ({ date, time: "00:00" })),
    ...input.events
      .filter((e) => dates.includes(e.localDate))
      .map((e) => ({ date: e.localDate, time: e.startTime })),
  ];
  const instants = [
    ...offsetShifts,
    ...wallTimes.flatMap(({ date, time }) =>
      [...offsets].map((offset) => wallClockMs(date, time) - offset),
    ),
    ...input.tasks.flatMap((t) => [t.windowStart - EARLY_CONFIRM_MS, t.windowStart, t.windowEnd]),
  ];
  return [...new Set(instants)].filter((at) => at > from && at < until).sort((a, b) => a - b);
}

export function buildPhoneTimeline(input: TimelineInput, now: number): PhoneTimeline {
  const until = now + TIMELINE_HORIZON_MS;
  const first = cardsAt(input, now);
  const changes: TimelineEntry[] = [];
  let shown = canonicalJson(first);
  for (const at of changeInstants(input, now, until)) {
    const cards = cardsAt(input, at);
    const key = canonicalJson(cards);
    if (key === shown) continue;
    changes.push({ at, cards });
    shown = key;
  }
  return {
    version: fnv1a64(canonicalJson({ timezone: input.timezone, first, changes })),
    generatedAt: now,
    timezone: input.timezone,
    until,
    entries: [{ at: now, cards: first }, ...changes],
  };
}

export async function loadPhoneTimeline(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<PhoneTimeline> {
  const day = await loadDeviceDay(ctx, householdId, now);
  return buildPhoneTimeline(timelineInput(day, now), now);
}
