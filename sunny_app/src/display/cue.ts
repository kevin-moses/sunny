// sunny_app/src/display/cue.ts
//
// Purpose: Pure rules of the home display's due cue (useDueCue plays it). A cue is a soft
// chime followed by the task's fixed spoken prompt. It is owed once when a timed task comes
// due, and again each time the backend sends the senior a reprompt: the day view's
// seniorPrompts counts the prompts the task's escalation policy has sent, so a cue is
// identified by the instance, that count and the end of its latest snooze (cueKey). Keys
// already cued are remembered on the device, so a restart does not cue a task again. Anytime
// (untimed) tasks are never due, so they never cue; a confirmed task is no longer due, so a
// cue still owed for it is dropped.
//
// Snooze: each snooze ("not yet") changes the task's snoozedUntil, so it owes one new cue,
// even when the task's cue already played and the backend has no prompt step left to send.
// That cue waits while the task is snoozed and plays when the snooze ends, unless the task was
// confirmed meanwhile. When the snooze ends the backend may also send the prompt it held back,
// a moment before or after: a new prompt count within cueMinGapMs of the snooze end, for a
// task already cued since that snooze ended, is absorbed (remembered as played without
// sounding), so the snooze end gives one cue in either order. Prompts that are not around a
// snooze end are never absorbed, however close together the policy sends them.
//
// The words are the same every time: the caregiver's spoken prompt when they wrote one,
// otherwise a fixed template from the display label and time ("Time for Morning pills, at
// 8 o'clock. Press Done when you have taken them."). The backend fills a blank prompt with
// "Time for <label>.", so that exact text counts as no prompt written.
//
// Last modified: 2026-11-09

import { clockTime, isDue } from '../day/format';
import type { DayTask } from '../day/types';

/** The prompt the developer sheet's test cue speaks: the template for an 8:00 medication. */
export const SAMPLE_PROMPT =
  "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.";

/**
 * purpose: The identity of one cue: the instance, how many prompts the backend has sent, and
 *          when its latest snooze ends (so each snooze owes a cue of its own).
 * @param task: (Pick<DayTask, 'instanceId' | 'seniorPrompts' | 'snoozedUntil'>) The task.
 * @return: (string) "<instanceId>:<seniorPrompts>", plus ":<snoozedUntil>" once snoozed.
 */
export function cueKey(
  task: Pick<DayTask, 'instanceId' | 'seniorPrompts' | 'snoozedUntil'>,
): string {
  const base = `${task.instanceId}:${task.seniorPrompts}`;
  return task.snoozedUntil == null ? base : `${base}:${task.snoozedUntil}`;
}

/**
 * purpose: The instance a cue key belongs to: the key without its trailing number parts.
 * @param key: (string) A cue key.
 * @return: (string) The instance id.
 */
function keyInstance(key: string): string {
  return key.replace(/(:\d+)+$/, '');
}

/**
 * purpose: Whether a task may be cued at all: due (timed, due or escalated) and not snoozed.
 * @param task: (DayTask) The task.
 * @return: (boolean) True when a cue for it may play.
 */
export function isCueable(task: DayTask): boolean {
  return isDue(task) && !task.snoozed;
}

/** Which owed cues to play now and which to absorb. */
interface CueChoice {
  /** Tasks to cue now, in day order. */
  play: DayTask[];
  /** Prompts arriving around a snooze end that already cued: remembered, not sounded. */
  absorb: DayTask[];
}

/** When each task was last cued, to tell a snooze-end reprompt from a cue of its own. */
interface CueSpacing {
  /** Epoch ms of the last cue that played, by instance id. */
  lastCueAt: ReadonlyMap<string, number>;
  /** Epoch ms now. */
  now: number;
  /** How long after a snooze end a new prompt counts as part of it (ms). */
  minGapMs: number;
}

/**
 * purpose: The cues owed now: due timed tasks whose current cue has not been played. Snoozed
 *          ones stay owed (neither played nor absorbed). A task whose snooze ended less than
 *          minGapMs ago and that has been cued since it ended is absorbed; the rest play.
 * @param tasks: (DayTask[]) The day view's tasks, in its order.
 * @param cued: (ReadonlySet<string>) Cue keys already played (or absorbed) on this device.
 * @param spacing: (CueSpacing) When each task was last cued, now, and the minimum gap.
 * @return: (CueChoice) The tasks to play and to absorb.
 */
export function cueChoice(
  tasks: DayTask[],
  cued: ReadonlySet<string>,
  spacing: CueSpacing,
): CueChoice {
  const owed = tasks.filter((task) => isCueable(task) && !cued.has(cueKey(task)));
  /**
   * purpose: Whether a task's new cue is the backend's prompt around a snooze end that has
   *          already been cued.
   * @param task: (DayTask) The task.
   * @return: (boolean) True when its snooze ended less than minGapMs ago and it was cued since.
   */
  const snoozeEndRepeat = (task: DayTask): boolean => {
    const ended = task.snoozedUntil;
    const last = spacing.lastCueAt.get(task.instanceId);
    if (ended == null || last === undefined) return false;
    return last >= ended && spacing.now - ended < spacing.minGapMs;
  };
  return { play: owed.filter((t) => !snoozeEndRepeat(t)), absorb: owed.filter(snoozeEndRepeat) };
}

/**
 * purpose: The remembered cue keys after cueing some tasks, keeping only keys of instances
 *          still in the day view so the set never grows past today.
 * @param cued: (ReadonlySet<string>) Keys already played.
 * @param played: (DayTask[]) Tasks just cued.
 * @param tasks: (DayTask[]) The day view's tasks.
 * @return: (Set<string>) The keys to remember.
 */
export function rememberCued(
  cued: ReadonlySet<string>,
  played: DayTask[],
  tasks: DayTask[],
): Set<string> {
  const live = new Set<string>(tasks.map((t) => t.instanceId));
  const next = new Set<string>();
  for (const key of [...cued, ...played.map(cueKey)]) {
    if (live.has(keyInstance(key))) next.add(key);
  }
  return next;
}

/**
 * purpose: A local time as speech: "8 o'clock" on the hour, otherwise "8:30".
 * @param localTime: (string) Household-local "HH:MM".
 * @return: (string) The spoken time.
 */
export function spokenTime(localTime: string): string {
  const clock = clockTime(localTime);
  return clock.endsWith(':00') ? `${clock.slice(0, -3)} o'clock` : clock;
}

/**
 * purpose: Whether the caregiver wrote the task's spoken prompt (the backend's default for a
 *          blank prompt does not count).
 * @param task: (Pick<DayTask, 'spokenPrompt' | 'displayLabel'>) The task.
 * @return: (boolean) True for a caregiver-written prompt.
 */
export function hasWrittenPrompt(task: Pick<DayTask, 'spokenPrompt' | 'displayLabel'>): boolean {
  const prompt = task.spokenPrompt.trim();
  return prompt !== '' && prompt !== `Time for ${task.displayLabel}.`;
}

/**
 * purpose: The words spoken after the chime.
 * @param task: (DayTask) The task.
 * @return: (string) The caregiver's prompt, or the fixed template.
 */
export function cueSpeech(task: DayTask): string {
  if (hasWrittenPrompt(task)) return task.spokenPrompt.trim();
  const finish = task.type === 'medication' ? 'taken them' : 'finished';
  const when = spokenTime(task.scheduledTime);
  return `Time for ${task.displayLabel}, at ${when}. Press Done when you have ${finish}.`;
}
