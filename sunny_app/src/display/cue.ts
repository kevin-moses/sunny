// sunny_app/src/display/cue.ts
//
// Purpose: Pure rules of the home display's due cue (useDueCue plays it). A cue is a soft
// chime followed by the task's fixed spoken prompt. It is owed once when a timed task comes
// due, and again each time the backend sends the senior a reprompt: the day view's
// seniorPrompts counts the prompts the task's escalation policy has sent, so a cue is
// identified by the instance and that count (cueKey). Keys already cued are remembered on the
// device, so a restart does not cue a task again. Anytime (untimed) tasks are never due, so
// they never cue; a confirmed task is no longer due, so a cue still owed for it is dropped.
//
// The words are the same every time: the caregiver's spoken prompt when they wrote one,
// otherwise a fixed template from the display label and time ("Time for Morning pills, at
// 8 o'clock. Press Done when you have taken them."). The backend fills a blank prompt with
// "Time for <label>.", so that exact text counts as no prompt written.
//
// Last modified: 2026-11-09

import { clockTime, isDue } from '../day/format';
import type { DayTask } from '../day/types';

/**
 * purpose: The identity of one cue: the instance and how many prompts the backend has sent.
 * @param task: (Pick<DayTask, 'instanceId' | 'seniorPrompts'>) The task.
 * @return: (string) "<instanceId>:<seniorPrompts>".
 */
export function cueKey(task: Pick<DayTask, 'instanceId' | 'seniorPrompts'>): string {
  return `${task.instanceId}:${task.seniorPrompts}`;
}

/**
 * purpose: The tasks owed a cue: due timed tasks whose current cue has not been played.
 * @param tasks: (DayTask[]) The day view's tasks, in its order.
 * @param cued: (ReadonlySet<string>) Cue keys already played on this device.
 * @return: (DayTask[]) The tasks to cue now, in day order.
 */
export function tasksToCue(tasks: DayTask[], cued: ReadonlySet<string>): DayTask[] {
  return tasks.filter((task) => isDue(task) && !cued.has(cueKey(task)));
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
    if (live.has(key.slice(0, key.lastIndexOf(':')))) next.add(key);
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
  return `Time for ${task.displayLabel}, at ${spokenTime(task.scheduledTime)}. Press Done when you have ${finish}.`;
}
