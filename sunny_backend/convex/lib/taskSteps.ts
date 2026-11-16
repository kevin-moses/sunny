import type { Doc } from "../_generated/dataModel";
import { SENIOR_UNDO_MS, isDoneState } from "./confirmRule";
import { TASK_CAPS } from "./taskDraft";

export interface TaskStep {
  index: number;
  count: number;
  text: string;
}

export type StepPress = NonNullable<Doc<"taskInstances">["stepPresses"]>[number];

type StepFields = Pick<Doc<"taskInstances">, "currentStep" | "stepPresses">;

export const OTHER_STEP = "The task is not on the step that was pressed";

export const STEP_NOT_VALID = `step must be a whole number from 0 to ${TASK_CAPS.checklistItems - 1}`;

export function isMultiStep(items: readonly string[]): boolean {
  return items.length >= 2;
}

export function taskStep(items: readonly string[], stored: number | undefined): TaskStep | null {
  if (!isMultiStep(items)) return null;
  const index = Math.max(0, Math.min(Math.floor(stored ?? 0), items.length - 1));
  return { index, count: items.length, text: items[index]! };
}

export function isStepIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < TASK_CAPS.checklistItems;
}

export function stepIndex(step: TaskStep | null): number {
  return step?.index ?? 0;
}

export function pressedOtherStep(step: TaskStep | null, pressed: number | undefined): boolean {
  return pressed !== undefined && pressed !== stepIndex(step);
}

export function hasStepAfter(step: TaskStep | null): step is TaskStep {
  return step !== null && step.index < step.count - 1;
}

export function stepPressed(instance: StepFields, pressId: string): boolean {
  return (instance.stepPresses ?? []).some((p) => p.pressId === pressId);
}

export function latestStepPress(instance: StepFields): StepPress | null {
  return instance.stepPresses?.at(-1) ?? null;
}

export function advancedStep(
  instance: StepFields,
  step: TaskStep,
  press: Omit<StepPress, "step">,
): Pick<Doc<"taskInstances">, "currentStep" | "stepPresses" | "snoozedUntil"> {
  return {
    currentStep: step.index + 1,
    stepPresses: [...(instance.stepPresses ?? []), { ...press, step: step.index }],
    snoozedUntil: undefined,
  };
}

export function steppedBack(
  instance: StepFields,
): Pick<Doc<"taskInstances">, "currentStep" | "stepPresses"> {
  const presses = instance.stepPresses ?? [];
  const last = presses.at(-1);
  return {
    currentStep: last === undefined ? instance.currentStep : last.step,
    stepPresses: presses.slice(0, -1),
  };
}

export function seniorCanUndoStep(
  instance: StepFields & Pick<Doc<"taskInstances">, "state">,
  userId: string,
  pressId: string,
  tappedAt: number,
): boolean {
  const last = latestStepPress(instance);
  return (
    !isDoneState(instance.state) &&
    last !== null &&
    last.by === userId &&
    last.pressId === pressId &&
    tappedAt - last.at <= SENIOR_UNDO_MS
  );
}

export function hasStepProgress(instance: StepFields): boolean {
  return (instance.currentStep ?? 0) > 0 || (instance.stepPresses?.length ?? 0) > 0;
}

export function stepPressIds(instance: StepFields, userId: string | null = null): string[] {
  return (instance.stepPresses ?? []).flatMap((p) =>
    p.pressId !== undefined && (userId === null || p.by === userId) ? [p.pressId] : [],
  );
}

export function visibleStepPressIds(instance: StepFields, userId: string | null): string[] {
  return userId === null ? [] : stepPressIds(instance, userId);
}
