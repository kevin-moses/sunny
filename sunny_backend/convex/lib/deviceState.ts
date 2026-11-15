import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { householdWeek } from "../calendar";
import { ANYTIME, compareDayOrder, isAnytimeInstance } from "./anytime";
import { isDoneState } from "./confirmRule";
import {
  clockTime,
  cueSpeech,
  doneQuestion,
  fullDate,
  relativeDayName,
  taskIcon,
} from "./deviceWording";
import type { DeviceIcon } from "./deviceWording";
import { isDueEntry } from "./dueTask";
import {
  escalationSteps,
  isOpenState,
  isSnoozed,
  seniorPromptCount,
  upcomingPromptTimes,
} from "./escalation";
import type { EscalationStep, PromptTiming } from "./escalation";
import { occurrenceJson } from "./occurrences";
import type { OccurrenceJson } from "./occurrences";
import {
  DAY_MS,
  MINUTE_MS,
  addDays,
  dateLabel,
  localDate,
  localTime,
  offsetAt,
  partOfDay,
  weekdayName,
} from "./time";
import { taskStep } from "./taskSteps";
import type { TaskStep } from "./taskSteps";
import { todayInstances } from "./today";
import type { TodayEntry } from "./today";

export const MAX_TODAY_ROWS = 7;

export const CUE_HORIZON_MS = DAY_MS;

export type CarouselPage = "now" | "today";

export interface DeviceTuning {
  checkAfterMs: { powered: number; battery: number };
  carousel: { pages: CarouselPage[]; intervalMs: number };
}

function deviceTuning(): DeviceTuning {
  return {
    checkAfterMs: { powered: 20_000, battery: 120_000 },
    carousel: { pages: ["now", "today"], intervalMs: 45_000 },
  };
}

export type DayTask = Pick<
  TodayEntry,
  | "instanceId"
  | "localDate"
  | "type"
  | "displayLabel"
  | "spokenPrompt"
  | "pillDescription"
  | "checklistItems"
  | "step"
  | "scheduledTime"
  | "state"
  | "carriedOver"
  | "confirmable"
  | "seniorPrompts"
  | "snoozedUntil"
>;

export type DayEvent = Pick<
  OccurrenceJson,
  "eventId" | "label" | "startTime" | "visitorName" | "localDate" | "startsAt" | "endsAt"
>;

export const EVENT_DEFAULT_MS = 60 * MINUTE_MS;

export type ItemType = TodayEntry["type"] | "event";

export type CueEntry = Pick<
  DayTask,
  | "instanceId"
  | "localDate"
  | "type"
  | "displayLabel"
  | "spokenPrompt"
  | "step"
  | "scheduledTime"
  | "state"
  | "seniorPrompts"
  | "snoozedUntil"
>;

export interface CueInput {
  entry: CueEntry;
  timing: PromptTiming;
  steps: readonly EscalationStep[];
}

export interface DeviceStateInput {
  seniorPreferredName: string;
  timezone: string;
  tasks: DayTask[];
  eventsToday: DayEvent[];
  upcoming: DayEvent[];
  cueInputs: CueInput[];
}

export interface NowTask {
  instanceId: Id<"taskInstances">;
  type: TodayEntry["type"];
  label: string;
  time: string;
  icon: DeviceIcon;
  question: string;
  pillDescription: string | null;
  overdue: boolean;
  early: boolean;
  steps: string[] | null;
  step: TaskStep | null;
}

export interface NowCard {
  kind: "task" | "clear";
  task: NowTask | null;
  allDone: boolean;
}

export interface DoneTarget {
  instanceId: Id<"taskInstances">;
  early: boolean;
}

export interface NextItem {
  title: string;
  when: string;
  icon: DeviceIcon;
  initial: string | null;
  type: ItemType;
}

export interface TodayRow {
  key: string;
  time: string;
  label: string;
  type: ItemType;
  mark: "done" | "now" | "missed" | "past" | "none";
}

export interface Cue {
  instanceId: Id<"taskInstances">;
  localDate: string;
  speech: string;
  cueableNow: boolean;
  seniorPrompts: number;
  snoozed: boolean;
  snoozedUntil: number | null;
  promptTimes: number[];
}

export interface DeviceState {
  version: string;
  displayVersion: string;
  generatedAt: number;
  seniorPreferredName: string;
  timezone: string;
  utcOffsetMinutes: number;
  localDate: string;
  header: string;
  dateLabel: string;
  fullDate: string;
  now: NowCard;
  done: DoneTarget | null;
  nextUp: NextItem | null;
  nextUpAfterDue: NextItem | null;
  rows: TodayRow[];
  rowsHidden: number;
  cues: Cue[];
  tuning: DeviceTuning;
}

export type AgendaItem =
  | { kind: "task"; id: string; time: string; task: DayTask }
  | { kind: "event"; id: string; time: string; event: DayEvent };

function isMissed(task: Pick<DayTask, "state">): boolean {
  return task.state === "missed";
}

function taskMark(task: DayTask, nowTaskId: string | null): TodayRow["mark"] {
  if (task.instanceId === nowTaskId) return "now";
  if (isDoneState(task.state)) return "done";
  return isMissed(task) ? "missed" : "none";
}

export function isDue(task: Pick<DayTask, "state" | "scheduledTime">): boolean {
  return isDueEntry(task) && !isAnytimeInstance(task);
}

export function doneTarget<T extends DayTask>(tasks: T[]): T | null {
  const due = tasks.find(isDue);
  if (due !== undefined) return due;
  return (
    tasks.find((t) => t.state === "upcoming" && t.confirmable && !isAnytimeInstance(t)) ?? null
  );
}

export function buildAgenda(tasks: DayTask[], events: DayEvent[]): AgendaItem[] {
  const items: AgendaItem[] = [
    ...tasks.map((task): AgendaItem => ({
      kind: "task",
      id: `task-${task.instanceId}`,
      time: task.scheduledTime,
      task,
    })),
    ...events.map((event): AgendaItem => ({
      kind: "event",
      id: `event-${event.eventId}-${event.localDate}`,
      time: event.startTime,
      event,
    })),
  ];
  return items.sort((a, b) => {
    const byAnytime = Number(a.time === ANYTIME) - Number(b.time === ANYTIME);
    if (byAnytime !== 0) return byAnytime;
    return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
  });
}

export function nowCard(
  tasks: DayTask[],
  target: DayTask | null,
  events: DayEvent[],
  time: string,
): NowCard {
  if (target !== null) {
    return {
      kind: "task",
      task: {
        instanceId: target.instanceId,
        type: target.type,
        label: target.displayLabel,
        time: clockTime(target.scheduledTime),
        icon: taskIcon(target.type),
        question: doneQuestion(target.type),
        pillDescription: target.pillDescription,
        overdue: target.state === "escalated" || target.carriedOver,
        early: target.state === "upcoming",
        steps: target.step === null ? null : [...target.checklistItems],
        step: target.step,
      },
      allDone: false,
    };
  }
  const openTask = tasks.some((t) => isOpenState(t.state));
  const laterEvent = events.some((e) => e.startTime > time);
  const anyMissed = tasks.some(isMissed);
  return { kind: "clear", task: null, allDone: !openTask && !laterEvent && !anyMissed };
}

function eventNext(event: DayEvent, when: string): NextItem {
  const visitor = event.visitorName?.trim() ?? "";
  return {
    title: event.label,
    when,
    icon: "calendar",
    initial: visitor === "" ? null : Array.from(visitor)[0]!.toUpperCase(),
    type: "event",
  };
}

export function isPastEvent(event: Pick<DayEvent, "startsAt" | "endsAt">, now: number): boolean {
  return now >= (event.endsAt ?? event.startsAt + EVENT_DEFAULT_MS);
}

export function nextItem(
  agenda: AgendaItem[],
  upcoming: DayEvent[],
  today: string,
  time: string,
  nowTaskId: string | null,
): NextItem | null {
  for (const item of agenda) {
    if (item.kind === "event") {
      if (item.event.startTime > time) {
        return eventNext(item.event, clockTime(item.event.startTime));
      }
      continue;
    }
    const { task } = item;
    if (isOpenState(task.state) && !isAnytimeInstance(task) && task.instanceId !== nowTaskId) {
      return {
        title: task.displayLabel,
        when: clockTime(task.scheduledTime),
        icon: taskIcon(task.type),
        initial: null,
        type: task.type,
      };
    }
  }
  const later = upcoming.find((e) => e.localDate > today);
  if (later === undefined) return null;
  const day = relativeDayName(later.localDate, today);
  const clock = clockTime(later.startTime);
  return eventNext(later, day === null ? clock : `${day}, ${clock}`);
}

export function todayRows(
  agenda: AgendaItem[],
  nowTaskId: string | null,
  maxRows: number = MAX_TODAY_ROWS,
  now: number | null = null,
): { rows: TodayRow[]; hidden: number } {
  const all = agenda.map((item): TodayRow => {
    if (item.kind === "event") {
      return {
        key: item.id,
        time: clockTime(item.event.startTime),
        label: item.event.label,
        type: "event",
        mark: now !== null && isPastEvent(item.event, now) ? "past" : "none",
      };
    }
    const { task } = item;
    return {
      key: item.id,
      time: clockTime(task.scheduledTime),
      label: task.displayLabel,
      type: task.type,
      mark: taskMark(task, nowTaskId),
    };
  });
  let excess = all.length - maxRows;
  const rows = all.filter((row) => {
    if (excess <= 0 || row.mark !== "done") return true;
    excess -= 1;
    return false;
  });
  if (rows.length <= maxRows) return { rows, hidden: 0 };
  const shown = Math.max(maxRows - 1, 0);
  return { rows: rows.slice(0, shown), hidden: rows.length - shown };
}

function cueList(inputs: CueInput[], now: number): Cue[] {
  const cues: Cue[] = [];
  for (const { entry, timing, steps } of inputs) {
    if (isAnytimeInstance(entry)) continue;
    const promptTimes = upcomingPromptTimes(timing, steps, now, now + CUE_HORIZON_MS);
    if (!isDue(entry) && promptTimes.length === 0) continue;
    const snoozed = isSnoozed(entry.snoozedUntil, now);
    cues.push({
      instanceId: entry.instanceId,
      localDate: entry.localDate,
      speech: cueSpeech(entry),
      cueableNow: isDue(entry) && !snoozed,
      seniorPrompts: entry.seniorPrompts,
      snoozed,
      snoozedUntil: entry.snoozedUntil,
      promptTimes,
    });
  }
  return cues;
}

function utcOffsetMinutes(now: number, timezone: string): number {
  return Math.round(offsetAt(now, timezone) / MINUTE_MS);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;
const UTF8 = new TextEncoder();

export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of UTF8.encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

export function buildDeviceState(input: DeviceStateInput, now: number): DeviceState {
  const { timezone } = input;
  const today = localDate(now, timezone);
  const time = localTime(now, timezone);
  const target = doneTarget(input.tasks);
  const nowTaskId = target?.instanceId ?? null;
  const agenda = buildAgenda(input.tasks, input.eventsToday);
  const { rows, hidden } = todayRows(agenda, nowTaskId, MAX_TODAY_ROWS, now);
  const dueTaskId = target !== null && isDue(target) ? target.instanceId : null;
  const label = dateLabel(today);
  const content = {
    seniorPreferredName: input.seniorPreferredName,
    timezone,
    utcOffsetMinutes: utcOffsetMinutes(now, timezone),
    localDate: today,
    header: `${weekdayName(today)} ${partOfDay(time)}`,
    dateLabel: label,
    fullDate: fullDate(label, today),
    now: nowCard(input.tasks, target, input.eventsToday, time),
    done:
      target === null
        ? null
        : { instanceId: target.instanceId, early: target.state === "upcoming" },
    nextUp: nextItem(agenda, input.upcoming, today, time, nowTaskId),
    nextUpAfterDue: nextItem(agenda, input.upcoming, today, time, dueTaskId),
    rows,
    rowsHidden: hidden,
    cues: cueList(input.cueInputs, now),
    tuning: deviceTuning(),
  };
  const drawn = {
    localDate: content.localDate,
    dateLabel: content.dateLabel,
    fullDate: content.fullDate,
    header: content.header,
    now: content.now,
    done: content.done,
    nextUp: content.nextUp,
    nextUpAfterDue: content.nextUpAfterDue,
    rows: content.rows,
    rowsHidden: content.rowsHidden,
  };
  return {
    version: fnv1a64(canonicalJson(content)),
    displayVersion: fnv1a64(canonicalJson(drawn)),
    generatedAt: now,
    ...content,
  };
}

function taskLoader(ctx: QueryCtx): (taskId: Id<"tasks">) => Promise<Doc<"tasks"> | null> {
  const cache = new Map<Id<"tasks">, Promise<Doc<"tasks"> | null>>();
  return (taskId: Id<"tasks">): Promise<Doc<"tasks"> | null> => {
    let loaded = cache.get(taskId);
    if (loaded === undefined) {
      loaded = ctx.db.get(taskId);
      cache.set(taskId, loaded);
    }
    return loaded;
  };
}

function cueInputFor(instance: Doc<"taskInstances">, task: Doc<"tasks"> | null): CueInput | null {
  if (task === null) return null;
  return {
    entry: {
      instanceId: instance._id,
      localDate: instance.localDate,
      type: task.type,
      displayLabel: task.displayLabel,
      spokenPrompt: task.spokenPrompt,
      step: taskStep(task.checklistItems, instance.currentStep),
      scheduledTime: instance.scheduledTime,
      state: instance.state,
      seniorPrompts: seniorPromptCount(instance.firedSteps),
      snoozedUntil: instance.snoozedUntil ?? null,
    },
    timing: instance,
    steps: escalationSteps(task),
  };
}

export async function loadDeviceState(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<DeviceState> {
  const [{ household, today, week }, tasks] = await Promise.all([
    householdWeek(ctx, householdId, now),
    todayInstances(ctx, householdId, now, null),
  ]);
  const tomorrow = (
    await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) =>
        q.eq("householdId", householdId).eq("localDate", addDays(today, 1)),
      )
      .collect()
  ).sort(compareDayOrder);
  const todays = await Promise.all(tasks.map((e) => ctx.db.get(e.instanceId)));
  const instances = [...todays, ...tomorrow].filter((i) => i !== null);
  const loadTask = taskLoader(ctx);
  const loaded = await Promise.all(instances.map((i) => loadTask(i.taskId)));
  const cueInputs = instances
    .map((i, n) => cueInputFor(i, loaded[n] ?? null))
    .filter((c) => c !== null);
  return buildDeviceState(
    {
      seniorPreferredName: household.seniorPreferredName,
      timezone: household.timezone,
      tasks,
      eventsToday: week.filter((o) => o.localDate === today).map(occurrenceJson),
      upcoming: week.filter((o) => o.localDate > today).map(occurrenceJson),
      cueInputs,
    },
    now,
  );
}
