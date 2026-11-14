// lib/deviceWording.ts
// Purpose: The words and labels a senior surface shows or speaks, ported from the app so the
// backend's device state (lib/deviceState.ts) produces exactly what the home display renders
// today: clock times without AM or PM ("8:00", "Anytime"; sunny_app/src/day/format.ts
// clockTime), the spoken time and the due cue's sentence (sunny_app/src/display/cue.ts
// spokenTime, hasWrittenPrompt, cueSpeech), the question above the Done key and a task type's
// icon name, the date line with the year, and a later day's name (sunny_app/src/display/model.ts
// doneQuestion, taskIcon, fullDate; day/format.ts relativeDayName). Icon names are the SF Symbol
// names the app draws; other surfaces map them to their own glyphs. Change wording here and in
// the app together until the app reads it from the device state.
//
// Last modified: 2026-11-13

import { ANYTIME } from "./anytime";
import { daysBetween, isLocalDate, weekdayName } from "./time";
import type { TaskType } from "./validators";

/** The icon names a surface draws: one per task type, and "calendar" for events. */
export type DeviceIcon = "pills" | "calendar" | "checklist" | "bell" | "clock";

/** The task fields the cue sentence reads. */
export interface SpeechTask {
  type: TaskType;
  displayLabel: string;
  spokenPrompt: string;
  scheduledTime: string;
}

/**
 * purpose: Split a local "HH:MM" time into its 24-hour hour and its minute text.
 * @param localTime: (string) Household-local time.
 * @return: ({ hour: number; minute: string } | null) The parts, or null when it is not a valid
 *          time (including the anytime sentinel).
 */
function timeParts(localTime: string): { hour: number; minute: string } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (match === null) return null;
  const hour = Number(match[1]);
  if (hour > 23 || Number(match[2]) > 59) return null;
  return { hour, minute: match[2]! };
}

/**
 * purpose: A local "HH:MM" time on a 12-hour clock without AM or PM, for example "2:00" (the
 *          home display's form); "Anytime" for the anytime sentinel.
 * @param localTime: (string) Household-local time.
 * @return: (string) The clock time, or the input unchanged when it is not a valid time.
 */
export function clockTime(localTime: string): string {
  if (localTime === ANYTIME) return "Anytime";
  const parts = timeParts(localTime);
  if (parts === null) return localTime;
  return `${parts.hour % 12 === 0 ? 12 : parts.hour % 12}:${parts.minute}`;
}

/**
 * purpose: A local time as speech: "8 o'clock" on the hour, otherwise "8:30".
 * @param localTime: (string) Household-local "HH:MM".
 * @return: (string) The spoken time.
 */
export function spokenTime(localTime: string): string {
  const clock = clockTime(localTime);
  return clock.endsWith(":00") ? `${clock.slice(0, -3)} o'clock` : clock;
}

/**
 * purpose: Whether the caregiver wrote the task's spoken prompt (the backend's default for a
 *          blank prompt, "Time for <label>.", does not count).
 * @param task: (Pick<SpeechTask, "spokenPrompt" | "displayLabel">) The task.
 * @return: (boolean) True for a caregiver-written prompt.
 */
export function hasWrittenPrompt(task: Pick<SpeechTask, "spokenPrompt" | "displayLabel">): boolean {
  const prompt = task.spokenPrompt.trim();
  return prompt !== "" && prompt !== `Time for ${task.displayLabel}.`;
}

/**
 * purpose: The words spoken after the due cue's chime: the caregiver's prompt, or the fixed
 *          template from the label and time ("Time for Morning pills, at 8 o'clock. Press Done
 *          when you have taken them.").
 * @param task: (SpeechTask) The task.
 * @return: (string) The sentence.
 */
export function cueSpeech(task: SpeechTask): string {
  if (hasWrittenPrompt(task)) return task.spokenPrompt.trim();
  const finish = task.type === "medication" ? "taken them" : "finished";
  const when = spokenTime(task.scheduledTime);
  return `Time for ${task.displayLabel}, at ${when}. Press Done when you have ${finish}.`;
}

/**
 * purpose: The question above the Done key: "Taken them?" for medication, "Finished?" for
 *          anything else.
 * @param type: (TaskType) The task type.
 * @return: (string) The question.
 */
export function doneQuestion(type: TaskType): string {
  return type === "medication" ? "Taken them?" : "Finished?";
}

/**
 * purpose: The icon of a task type.
 * @param type: (TaskType) The task type.
 * @return: (DeviceIcon) The icon name (the SF Symbol the app draws).
 */
export function taskIcon(type: TaskType): DeviceIcon {
  switch (type) {
    case "medication":
      return "pills";
    case "appointment":
      return "calendar";
    case "checklist":
      return "checklist";
    case "reminder":
      return "bell";
    case "routine":
      return "clock";
  }
}

/**
 * purpose: The date line under the header, with the year: "November 8, 2026".
 * @param dateLabel: (string) The date without the year, "November 8".
 * @param localDate: (string) The same date, "YYYY-MM-DD".
 * @return: (string) The date line.
 */
export function fullDate(dateLabel: string, localDate: string): string {
  return `${dateLabel}, ${localDate.slice(0, 4)}`;
}

/**
 * purpose: The name of a local date relative to today: "Today", "Tomorrow" or the weekday.
 * @param date: (string) The date, "YYYY-MM-DD".
 * @param today: (string) The household's local date.
 * @return: (string | null) The name, or null when either date is malformed.
 */
export function relativeDayName(date: string, today: string): string | null {
  if (!isLocalDate(date) || !isLocalDate(today)) return null;
  const days = daysBetween(today, date);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return weekdayName(date);
}
