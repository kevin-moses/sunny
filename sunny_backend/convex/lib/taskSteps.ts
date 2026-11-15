import type { Doc } from "../_generated/dataModel";
import { SENIOR_UNDO_MS } from "./confirmRule";
import { isOpenState } from "./escalation";

export interface TaskStep {
  index: number;
  count: number;
  text: string;
}

export type StepPress = NonNullable<Doc<"taskInstances">["stepPresses"]>[number];

type StepFields = Pick<Doc<"taskInstances">, "currentStep" | "stepPresses">;

export function isMultiStep(items: readonly string[]): boolean {
  return items.length >= 2;
}

export function taskStep(items: readonly string[], stored: number | undefined): TaskStep | null {
  if (!isMultiStep(items)) return null;
  const index = Math.max(0, Math.min(Math.floor(stored ?? 0), items.length - 1));
  return { index, count: items.length, text: items[index]! };
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
): Pick<Doc<"taskInstances">, "currentStep" | "stepPresses"> {
  return {
    currentStep: step.index + 1,
    stepPresses: [...(instance.stepPresses ?? []), { ...press, step: step.index }],
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
  pressId: string | undefined,
  tappedAt: number,
): boolean {
  const last = latestStepPress(instance);
  return (
    isOpenState(instance.state) &&
    last !== null &&
    last.by === userId &&
    pressId !== undefined &&
    last.pressId === pressId &&
    tappedAt - last.at <= SENIOR_UNDO_MS
  );
}

export function visibleStepPressIds(instance: StepFields, userId: string | null): string[] {
  if (userId === null) return [];
  return (instance.stepPresses ?? []).flatMap((p) =>
    p.by === userId && p.pressId !== undefined ? [p.pressId] : [],
  );
}
