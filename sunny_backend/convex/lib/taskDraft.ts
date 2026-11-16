import { appError } from "./errors";
import type { TaskFields } from "./schedule";
import { normalizeWeekdays, requireMaxLength, requireNonBlank } from "./text";
import { isLocalDate, isLocalTime } from "./time";

export type TaskDraft = Omit<
  TaskFields,
  "householdId" | "createdByKind" | "createdBy" | "scheduleChangedAt"
>;

export const TASK_CAPS = {
  title: 200,
  displayLabel: 60,
  spokenPrompt: 300,
  pillDescription: 200,
  times: 24,
  checklistItems: 50,
  checklistItem: 200,
} as const;

const MAX_WINDOW_MINUTES = 720;

const ELLIPSIS = "…";

export function isAsNeededTask(
  task: Pick<TaskFields, "type" | "times" | "asNeededMaxPerDay" | "asNeededMinHours">,
): boolean {
  return (
    task.type === "medication" &&
    task.times.length === 0 &&
    (task.asNeededMaxPerDay !== undefined || task.asNeededMinHours !== undefined)
  );
}

export function clippedLabel(text: string): string {
  const max = TASK_CAPS.displayLabel;
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const lastBreak = room.search(/\s\S*$/);
  const wordEnds = /\s/.test(text.charAt(max - 1));
  const kept = wordEnds || lastBreak <= 0 ? room : room.slice(0, lastBreak);
  return `${kept.trimEnd().replace(/[\uD800-\uDBFF]$/, "")}${ELLIPSIS}`;
}

function normalizeSchedule(draft: TaskDraft): TaskDraft {
  for (const time of draft.times) {
    if (!isLocalTime(time)) throw appError("invalid", `Time ${time} must be HH:MM`);
  }
  if (new Set(draft.times).size !== draft.times.length) {
    throw appError("invalid", "Times must be unique");
  }
  let daysOfWeek = draft.daysOfWeek;
  if (daysOfWeek !== undefined) {
    daysOfWeek = normalizeWeekdays(daysOfWeek, "Days of week must be 1 (Monday) to 7 (Sunday)");
  }
  for (const [label, date] of [
    ["Once on", draft.onceOn],
    ["Starts on", draft.startsOn],
    ["Ends on", draft.endsOn],
  ] as const) {
    if (date !== undefined && !isLocalDate(date)) {
      throw appError("invalid", `${label} must be YYYY-MM-DD`);
    }
  }
  if (draft.onceOn !== undefined && daysOfWeek !== undefined) {
    throw appError("invalid", "A one-off task cannot also repeat on weekdays");
  }
  if (draft.startsOn !== undefined && draft.endsOn !== undefined && draft.endsOn < draft.startsOn) {
    throw appError("invalid", "Ends on cannot be before starts on");
  }
  const window = draft.windowMinutes;
  if (!Number.isInteger(window) || window < 1 || window > MAX_WINDOW_MINUTES) {
    throw appError("invalid", `Window must be 1 to ${MAX_WINDOW_MINUTES} minutes`);
  }
  return { ...draft, times: [...draft.times].sort(), daysOfWeek };
}

function enforceSizeCaps(draft: TaskDraft): void {
  requireMaxLength(draft.title, TASK_CAPS.title, "Title");
  requireMaxLength(draft.displayLabel, TASK_CAPS.displayLabel, "Display label");
  requireMaxLength(draft.spokenPrompt.trim(), TASK_CAPS.spokenPrompt, "Spoken prompt");
  if (draft.pillDescription !== undefined) {
    requireMaxLength(draft.pillDescription, TASK_CAPS.pillDescription, "Pill description");
  }
  if (draft.times.length > TASK_CAPS.times) {
    throw appError("invalid", `A task can have at most ${TASK_CAPS.times} times`);
  }
  if (draft.checklistItems.length > TASK_CAPS.checklistItems) {
    throw appError("invalid", `A checklist can have at most ${TASK_CAPS.checklistItems} items`);
  }
  for (const item of draft.checklistItems) {
    requireMaxLength(item, TASK_CAPS.checklistItem, "Checklist item");
  }
}

export function validateDraft(draft: TaskDraft): TaskDraft {
  const title = requireNonBlank(draft.title, "Title");
  const displayLabel = requireNonBlank(draft.displayLabel, "Display label");
  enforceSizeCaps({ ...draft, title, displayLabel });
  if (
    draft.active &&
    draft.type === "medication" &&
    draft.times.length === 0 &&
    !isAsNeededTask(draft)
  ) {
    throw appError(
      "invalid",
      "A medication needs at least one time (HH:MM) unless it is as-needed with a limit; ask the caregiver for the time instead of guessing",
    );
  }
  const spokenPrompt = draft.spokenPrompt.trim() || `Time for ${displayLabel}.`;
  const max = draft.asNeededMaxPerDay;
  if (max !== undefined && (!Number.isInteger(max) || max <= 0)) {
    throw appError("invalid", "As-needed maximum per day must be a positive whole number");
  }
  const minHours = draft.asNeededMinHours;
  if (minHours !== undefined && !(Number.isFinite(minHours) && minHours > 0)) {
    throw appError("invalid", "As-needed minimum hours must be positive");
  }
  return normalizeSchedule({ ...draft, title, displayLabel, spokenPrompt });
}
