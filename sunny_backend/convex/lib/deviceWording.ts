import type { Doc } from "../_generated/dataModel";
import { ANYTIME } from "./anytime";
import { taskStep } from "./taskSteps";
import type { TaskStep } from "./taskSteps";
import { daysBetween, isLocalDate, weekdayName } from "./time";
import type { TaskType } from "./validators";

export type DeviceIcon = "pills" | "calendar" | "checklist" | "bell" | "clock";

export interface SpeechTask {
  type: TaskType;
  displayLabel: string;
  spokenPrompt: string;
  scheduledTime: string;
  step: TaskStep | null;
}

function timeParts(localTime: string): { hour: number; minute: string } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (match === null) return null;
  const hour = Number(match[1]);
  if (hour > 23 || Number(match[2]) > 59) return null;
  return { hour, minute: match[2]! };
}

export function clockTime(localTime: string): string {
  if (localTime === ANYTIME) return "Anytime";
  const parts = timeParts(localTime);
  if (parts === null) return localTime;
  return `${parts.hour % 12 === 0 ? 12 : parts.hour % 12}:${parts.minute}`;
}

export function spokenTime(localTime: string): string {
  const clock = clockTime(localTime);
  return clock.endsWith(":00") ? `${clock.slice(0, -3)} o'clock` : clock;
}

export function hasWrittenPrompt(task: Pick<SpeechTask, "spokenPrompt" | "displayLabel">): boolean {
  const prompt = task.spokenPrompt.trim();
  return prompt !== "" && prompt !== `Time for ${task.displayLabel}.`;
}

export function stepSpeech(step: TaskStep): string {
  const text = step.text.trim();
  const end = /[.!?]$/.test(text) ? "" : ".";
  return `Step ${step.index + 1} of ${step.count}: ${text}${end}`;
}

export function withStepSpeech(speech: string, step: TaskStep | null): string {
  return step === null ? speech : `${speech} ${stepSpeech(step)}`;
}

export function seniorPromptWords(
  task: Pick<Doc<"tasks">, "displayLabel" | "spokenPrompt" | "checklistItems">,
  instance: Pick<Doc<"taskInstances">, "currentStep">,
): { title: string; body: string } {
  return {
    title: task.displayLabel,
    body: withStepSpeech(task.spokenPrompt, taskStep(task.checklistItems, instance.currentStep)),
  };
}

function baseCueSpeech(task: SpeechTask): string {
  if (hasWrittenPrompt(task)) return task.spokenPrompt.trim();
  const finish = task.type === "medication" ? "taken them" : "finished";
  const when = spokenTime(task.scheduledTime);
  return `Time for ${task.displayLabel}, at ${when}. Press Done when you have ${finish}.`;
}

export function cueSpeech(task: SpeechTask): string {
  return withStepSpeech(baseCueSpeech(task), task.step);
}

export function doneQuestion(type: TaskType): string {
  return type === "medication" ? "Taken them?" : "Finished?";
}

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

export function fullDate(dateLabel: string, localDate: string): string {
  return `${dateLabel}, ${localDate.slice(0, 4)}`;
}

export function relativeDayName(date: string, today: string): string | null {
  if (!isLocalDate(date) || !isLocalDate(today)) return null;
  const days = daysBetween(today, date);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return weekdayName(date);
}
