// lib/deviceState.ts
// Purpose: The device state: one server-computed object every senior surface renders (the
// phone app, the home display, the iOS widget and Live Activity, the e-ink display's firmware),
// so they all show the same thing and firmware only draws what it is given. buildDeviceState is
// the pure rule, taking the household's day (the inputs calendar.dayView gives a senior device:
// today's task entries from lib/today.ts, today's events and the coming week's) and `now`;
// loadDeviceState reads the database and calls it. deviceApi.state (Convex query, Clerk) and
// GET /device/state (HTTP, device token) both return loadDeviceState's object.
//
// Rules, ported from the app (sunny_app/src/display/model.ts, day/useDoneAction.ts,
// display/cue.ts, day/format.ts) with one product change:
// - done (the one task a Done press confirms) is the phone's rule, doneTarget: the first due or
//   escalated timed task in the day's order; otherwise the first upcoming timed task that may be
//   confirmed now (`confirmable`, lib/confirmRule.ts: up to 60 minutes early); never an anytime
//   or missed task. The display used to offer only a due task.
// - now (the Now card) shows that same task, so Done always confirms the task on screen: overdue
//   once escalated or carried over from yesterday, early when it is not due yet, and its steps
//   (two or more checklist items stand in for steps). Without one it is a clear card, all done
//   when no task is open and no event is still ahead today.
// - nextUp skips the Now task; rows (the Today page) mark it "now", done tasks "done", and drop
//   the earliest done rows first when there are more than MAX_TODAY_ROWS, then the latest
//   (rowsHidden counts those).
// - cues: what to chime and say. Every timed due or escalated task is listed (cueableNow says
//   whether it may cue right now: not snoozed), and every other open timed task, tomorrow's
//   included, that the escalation policy will prompt within CUE_HORIZON_MS. promptTimes are those
//   prompt instants, from lib/escalation.ts, the code the scheduler fires steps with, so an
//   offline device can chime on its own clock. The sentence is cueSpeech, word for word the
//   display's. The loader builds each cue from the instance and its task (prompt count, snooze
//   and the task's firing steps from lib/escalation.ts), for today's entries and tomorrow's
//   instances.
// - tuning: timings the server can change without new firmware (deviceTuning).
// Absent optional values are null, never a missing key. Times shown to the senior are
// household-local strings in the app's formats; instants are epoch ms. version is a short hash
// (FNV-1a 64 over canonical JSON) of everything except generatedAt: a change detector for ETag,
// not a secret.
//
// Last modified: 2026-11-14

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { householdWeek } from "../calendar";
import { ANYTIME, compareDayOrder, isAnytimeInstance } from "./anytime";
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
  activePolicySteps,
  isOpenState,
  isSnoozed,
  seniorPromptCount,
  upcomingPromptTimes,
} from "./escalation";
import type { PromptTiming } from "./escalation";
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
import { todayInstances } from "./today";
import type { TodayEntry } from "./today";
import type { EscalationStep } from "./validators";

/** How many rows fit on the Today page. */
export const MAX_TODAY_ROWS = 7;

/** How far ahead (ms) cues list the policy's prompt instants. */
export const CUE_HORIZON_MS = DAY_MS;

/** The pages a carousel shows, in order. */
export type CarouselPage = "now" | "today";

/** Timings the server sends so they can change without new firmware. */
export interface DeviceTuning {
  /** How long (ms) a device waits before checking for a new state, by power source. */
  checkAfterMs: { powered: number; battery: number };
  /** The pages a display rotates through and how long (ms) each stays. */
  carousel: { pages: CarouselPage[]; intervalMs: number };
}

/**
 * purpose: The device tuning values, the one place they are kept (a fresh object per state).
 * @return: (DeviceTuning) The values.
 */
function deviceTuning(): DeviceTuning {
  return {
    checkAfterMs: { powered: 20_000, battery: 120_000 },
    carousel: { pages: ["now", "today"], intervalMs: 45_000 },
  };
}

/** The task entry fields the rules read (a TodayEntry has them all). */
export type DayTask = Pick<
  TodayEntry,
  | "instanceId"
  | "localDate"
  | "type"
  | "displayLabel"
  | "spokenPrompt"
  | "pillDescription"
  | "checklistItems"
  | "scheduledTime"
  | "state"
  | "carriedOver"
  | "confirmable"
  | "seniorPrompts"
  | "snoozedUntil"
>;

/** The event occurrence fields the rules read (an OccurrenceJson has them all). */
export type DayEvent = Pick<
  OccurrenceJson,
  "eventId" | "label" | "startTime" | "visitorName" | "localDate"
>;

/** The instance and task fields a cue reads. */
export type CueEntry = Pick<
  DayTask,
  | "instanceId"
  | "localDate"
  | "type"
  | "displayLabel"
  | "spokenPrompt"
  | "scheduledTime"
  | "state"
  | "seniorPrompts"
  | "snoozedUntil"
>;

/** One instance the cue rules consider: its entry, its timing and its policy's steps. */
export interface CueInput {
  entry: CueEntry;
  /** The instance's own window, creation, snooze, claim and fired steps. */
  timing: PromptTiming;
  /** The task's policy steps; empty when the task is inactive or has no policy. */
  steps: readonly EscalationStep[];
}

/** What buildDeviceState reads. */
export interface DeviceStateInput {
  seniorPreferredName: string;
  timezone: string;
  /** Today's entries in day order, yesterday's still-open ones first (lib/today.ts). */
  tasks: DayTask[];
  /** Today's event occurrences. */
  eventsToday: DayEvent[];
  /** Occurrences on later days of the coming week, earliest first. */
  upcoming: DayEvent[];
  /** Today's and tomorrow's instances, in day order, for the cues. */
  cueInputs: CueInput[];
}

/** The task on the Now card. */
export interface NowTask {
  instanceId: Id<"taskInstances">;
  type: TodayEntry["type"];
  label: string;
  /** "8:00" (the display's clock form). */
  time: string;
  icon: DeviceIcon;
  /** "Taken them?" or "Finished?". */
  question: string;
  pillDescription: string | null;
  /** The family has been alerted, or the task is still open from yesterday. */
  overdue: boolean;
  /** Not due yet: Done would confirm it early. */
  early: boolean;
  /** The task's steps, or null for a one-step task. */
  steps: string[] | null;
}

/** What the Now card shows: a task, or a calm clear state. */
export interface NowCard {
  kind: "task" | "clear";
  /** The task; null exactly when kind is "clear". */
  task: NowTask | null;
  /** Clear and nothing is left today (no open task, no later event); false for a task. */
  allDone: boolean;
}

/** The task a Done press confirms. */
export interface DoneTarget {
  instanceId: Id<"taskInstances">;
  /** Not due yet (upcoming, within the early-confirm hour). */
  early: boolean;
}

/** The Next up card. */
export interface NextItem {
  title: string;
  /** "10:00", or "Tomorrow, 9:00" for a later day. */
  when: string;
  icon: DeviceIcon;
  /** The visitor's initial, drawn instead of the icon; null when nobody visits. */
  initial: string | null;
}

/** One row of the Today page. */
export interface TodayRow {
  key: string;
  time: string;
  label: string;
  /** done: checked and grey; now: the Now task, boxed and tagged; none: plain. */
  mark: "done" | "now" | "none";
}

/** A task to chime for and the sentence to say. */
export interface Cue {
  instanceId: Id<"taskInstances">;
  /** The instance's local date (tomorrow's for a cue on the next day). */
  localDate: string;
  /** Spoken after the chime. */
  speech: string;
  /** Due or escalated and not snoozed: it may cue now. */
  cueableNow: boolean;
  /** Senior prompts the policy has sent for it so far. */
  seniorPrompts: number;
  /** A snooze ("not yet") holds its prompts now. */
  snoozed: boolean;
  /** When the latest snooze ends or ended (epoch ms); null when never snoozed. */
  snoozedUntil: number | null;
  /** Epoch ms instants within CUE_HORIZON_MS at which the policy will prompt, ascending. */
  promptTimes: number[];
}

/** Everything a senior surface renders. */
export interface DeviceState {
  /** Hash of every other field except generatedAt; changes exactly when the content does. */
  version: string;
  /** When the state was computed (epoch ms). */
  generatedAt: number;
  seniorPreferredName: string;
  timezone: string;
  /** The household's offset from UTC now, in minutes (for a device's own clock). */
  utcOffsetMinutes: number;
  /** "YYYY-MM-DD". */
  localDate: string;
  /** "Saturday morning". */
  header: string;
  /** "November 7". */
  dateLabel: string;
  /** "November 7, 2026" (the display's date line). */
  fullDate: string;
  now: NowCard;
  done: DoneTarget | null;
  nextUp: NextItem | null;
  rows: TodayRow[];
  /** Later rows left out because they do not fit. */
  rowsHidden: number;
  cues: Cue[];
  tuning: DeviceTuning;
}

/** A line of today's agenda: a task or an event, ordered by local time. */
export type AgendaItem =
  | { kind: "task"; id: string; time: string; task: DayTask }
  | { kind: "event"; id: string; time: string; event: DayEvent };

/**
 * purpose: Whether a task was confirmed by the senior or a caregiver.
 * @param task: (Pick<DayTask, "state">) The task.
 * @return: (boolean) True once confirmed or resolved.
 */
function isDone(task: Pick<DayTask, "state">): boolean {
  return task.state === "confirmed" || task.state === "resolved";
}

/**
 * purpose: Whether it is time to act on a task: due or escalated, and timed (an anytime task is
 *          never due).
 * @param task: (Pick<DayTask, "state" | "scheduledTime">) The task.
 * @return: (boolean) True for a timed due or escalated task.
 */
export function isDue(task: Pick<DayTask, "state" | "scheduledTime">): boolean {
  return isDueEntry(task) && !isAnytimeInstance(task);
}

/**
 * purpose: The task a Done press confirms (the phone's rule): the first due or escalated timed
 *          task in the day's order; otherwise the first upcoming timed task that is
 *          confirmable now. Anytime and missed tasks are never the target.
 * @param tasks: (T[]) Today's tasks in the day's order.
 * @return: (T | null) The task, or null when there is nothing to confirm.
 */
export function doneTarget<T extends DayTask>(tasks: T[]): T | null {
  const due = tasks.find(isDue);
  if (due !== undefined) return due;
  return (
    tasks.find((t) => t.state === "upcoming" && t.confirmable && !isAnytimeInstance(t)) ?? null
  );
}

/**
 * purpose: Merge today's tasks and events into one list ordered by local time; anytime tasks
 *          come last. Ties keep tasks before events (the sort is stable).
 * @param tasks: (DayTask[]) Today's tasks.
 * @param events: (DayEvent[]) Today's events.
 * @return: (AgendaItem[]) The agenda.
 */
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

/**
 * purpose: The Now card for the Done target, or the clear state when there is none.
 * @param tasks: (DayTask[]) Today's tasks.
 * @param target: (DayTask | null) The Done target.
 * @param events: (DayEvent[]) Today's events.
 * @param time: (string) Household-local "HH:MM" now.
 * @return: (NowCard) The card.
 */
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
        steps: target.checklistItems.length >= 2 ? [...target.checklistItems] : null,
      },
      allDone: false,
    };
  }
  // A missed task (its window closed) is not waiting, so it does not keep the day open.
  const openTask = tasks.some((t) => isOpenState(t.state));
  const laterEvent = events.some((e) => e.startTime > time);
  return { kind: "clear", task: null, allDone: !openTask && !laterEvent };
}

/**
 * purpose: The Next up card for an event.
 * @param event: (DayEvent) The occurrence.
 * @param when: (string) Its when text.
 * @return: (NextItem) The card.
 */
function eventNext(event: DayEvent, when: string): NextItem {
  const visitor = event.visitorName?.trim() ?? "";
  return {
    title: event.label,
    when,
    icon: "calendar",
    initial: visitor === "" ? null : Array.from(visitor)[0]!.toUpperCase(),
  };
}

/**
 * purpose: The next thing after the Now task: the first later task or event today in agenda
 *          order, otherwise the next event on a later day ("Tomorrow, 9:00").
 * @param agenda: (AgendaItem[]) Today's agenda.
 * @param upcoming: (DayEvent[]) Occurrences on later days, earliest first.
 * @param today: (string) The household's local date.
 * @param time: (string) Household-local "HH:MM" now.
 * @param nowTaskId: (string | null) The Now task's instanceId, skipped here.
 * @return: (NextItem | null) The card, or null when nothing is coming.
 */
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
      };
    }
  }
  const later = upcoming.find((e) => e.localDate > today);
  if (later === undefined) return null;
  const day = relativeDayName(later.localDate, today);
  const clock = clockTime(later.startTime);
  return eventNext(later, day === null ? clock : `${day}, ${clock}`);
}

/**
 * purpose: The rows of the Today page. When there are more than fit, the earliest finished rows
 *          are dropped first, then the latest rows, which `hidden` counts.
 * @param agenda: (AgendaItem[]) Today's agenda.
 * @param nowTaskId: (string | null) The Now task's instanceId, marked "now".
 * @param maxRows: (number) How many rows fit, counting the "more" line when one is needed.
 * @return: ({ rows: TodayRow[]; hidden: number }) The rows and how many later ones were left out.
 */
export function todayRows(
  agenda: AgendaItem[],
  nowTaskId: string | null,
  maxRows: number = MAX_TODAY_ROWS,
): { rows: TodayRow[]; hidden: number } {
  const all = agenda.map((item): TodayRow => {
    if (item.kind === "event") {
      return {
        key: item.id,
        time: clockTime(item.event.startTime),
        label: item.event.label,
        mark: "none",
      };
    }
    const { task } = item;
    return {
      key: item.id,
      time: clockTime(task.scheduledTime),
      label: task.displayLabel,
      mark: task.instanceId === nowTaskId ? "now" : isDone(task) ? "done" : "none",
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

/**
 * purpose: The cues: every timed due or escalated task, and every other open timed task the
 *          policy will prompt within CUE_HORIZON_MS, in the inputs' order.
 * @param inputs: (CueInput[]) Today's and tomorrow's instances in day order.
 * @param now: (number) Epoch ms.
 * @return: (Cue[]) The cues.
 */
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

/**
 * purpose: The household's offset from UTC at an instant.
 * @param now: (number) Epoch ms.
 * @param timezone: (string) IANA zone.
 * @return: (number) Minutes east of UTC (New York in winter: -300).
 */
function utcOffsetMinutes(now: number, timezone: string): number {
  return Math.round(offsetAt(now, timezone) / MINUTE_MS);
}

/**
 * purpose: JSON with object keys sorted at every level, so equal content always serializes the
 *          same way.
 * @param value: (unknown) A JSON value.
 * @return: (string) The canonical JSON text.
 */
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

/** FNV-1a 64-bit offset basis and prime. */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;
const UTF8 = new TextEncoder();

/**
 * purpose: FNV-1a 64-bit hash of a string's UTF-8 bytes.
 * @param text: (string) The text.
 * @return: (string) 16 lowercase hex characters.
 */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of UTF8.encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * purpose: Turn the household's day into the device state at `now`. Pure.
 * @param input: (DeviceStateInput) The household's day.
 * @param now: (number) Epoch ms.
 * @return: (DeviceState) The state.
 */
export function buildDeviceState(input: DeviceStateInput, now: number): DeviceState {
  const { timezone } = input;
  const today = localDate(now, timezone);
  const time = localTime(now, timezone);
  const target = doneTarget(input.tasks);
  const nowTaskId = target?.instanceId ?? null;
  const agenda = buildAgenda(input.tasks, input.eventsToday);
  const { rows, hidden } = todayRows(agenda, nowTaskId);
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
    rows,
    rowsHidden: hidden,
    cues: cueList(input.cueInputs, now),
    tuning: deviceTuning(),
  };
  return { version: fnv1a64(canonicalJson(content)), generatedAt: now, ...content };
}

/** A task and the escalation steps it can fire. */
type TaskSteps = { task: Doc<"tasks">; steps: EscalationStep[] };

/**
 * purpose: A loader that reads each task, and the steps it can fire (lib/escalation.ts
 *          activePolicySteps, the scheduler's rule), once however many instances share it.
 * @param ctx: (QueryCtx) Context.
 * @return: ((taskId) => Promise<TaskSteps | null>) The loader; null for a task that is gone.
 */
function taskStepsLoader(ctx: QueryCtx): (taskId: Id<"tasks">) => Promise<TaskSteps | null> {
  const cache = new Map<Id<"tasks">, Promise<TaskSteps | null>>();
  return (taskId) => {
    let loaded = cache.get(taskId);
    if (loaded === undefined) {
      loaded = ctx.db
        .get(taskId)
        .then(async (task) =>
          task === null ? null : { task, steps: (await activePolicySteps(ctx, task)) ?? [] },
        );
      cache.set(taskId, loaded);
    }
    return loaded;
  };
}

/**
 * purpose: The cue input for one instance: what a cue says (from the instance and its task), the
 *          instance's timing, and the steps its task can fire. An instance whose task is gone is
 *          left out.
 * @param instance: (Doc<"taskInstances">) The instance.
 * @param loaded: (TaskSteps | null) Its task and steps, or null when the task is gone.
 * @return: (CueInput | null) The input, or null.
 */
function cueInputFor(instance: Doc<"taskInstances">, loaded: TaskSteps | null): CueInput | null {
  if (loaded === null) return null;
  const { task, steps } = loaded;
  return {
    entry: {
      instanceId: instance._id,
      localDate: instance.localDate,
      type: task.type,
      displayLabel: task.displayLabel,
      spokenPrompt: task.spokenPrompt,
      scheduledTime: instance.scheduledTime,
      state: instance.state,
      seniorPrompts: seniorPromptCount(instance.firedSteps),
      snoozedUntil: instance.snoozedUntil ?? null,
    },
    timing: instance,
    steps,
  };
}

/**
 * purpose: Read the household's day and build its device state at `now`. The cues cover today's
 *          entries (yesterday's still-open ones included) and tomorrow's instances, in day order.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<DeviceState>) The state.
 * @raises not_found when the household does not exist.
 */
export async function loadDeviceState(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<DeviceState> {
  const [{ household, today, week }, tasks] = await Promise.all([
    householdWeek(ctx, householdId, now),
    todayInstances(ctx, householdId, now),
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
  const loadTask = taskStepsLoader(ctx);
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
