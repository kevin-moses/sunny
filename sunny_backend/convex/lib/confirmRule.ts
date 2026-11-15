import type { Doc } from "../_generated/dataModel";
import { isAnytimeInstance, isAnytimeTask } from "./anytime";
import { localDate, minutes } from "./time";
import type { InstanceState } from "./validators";

export const EARLY_CONFIRM_MS = minutes(60);

export const LATE_SYNC_MS = minutes(5);

export const REPLAY_GRACE_MS = minutes(180);

export interface ConfirmRuleInput {
  state: InstanceState;
  windowStart: number;
}

export function notTooEarly(instance: ConfirmRuleInput, now: number): boolean {
  return !(instance.state === "upcoming" && instance.windowStart - now > EARLY_CONFIRM_MS);
}

export function seniorCanConfirm(instance: ConfirmRuleInput, now: number): boolean {
  return !isDoneState(instance.state) && notTooEarly(instance, now);
}

export function pressWasTakenBack(pressedAt: number, takenBackAt: number | undefined): boolean {
  return takenBackAt !== undefined && pressedAt <= takenBackAt;
}

const PRESS_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const MAX_TAKEN_BACK_PRESS_IDS = 8;

export const MAX_CONFIRM_PRESS_IDS = 4;

export const PRESS_ID_NOT_VALID = "The press id is not valid";

export const PRESS_TAKEN_BACK = "This press was taken back";

export const PRESS_BEFORE_TAKE_BACK = "This press was made before the confirmation was taken back";

export function isPressId(value: string): boolean {
  return PRESS_ID_PATTERN.test(value);
}

export interface QueuedPress {
  pressedAt: number;
  pressId: string | undefined;
  userId: string;
}

export function queuedPressTakenBack(
  press: QueuedPress,
  instance: Pick<
    Doc<"taskInstances">,
    "confirmTakenBackAt" | "confirmTakenBackBy" | "takenBackPressIds"
  >,
): string | null {
  if (press.pressId !== undefined) {
    if (instance.takenBackPressIds?.includes(press.pressId)) return PRESS_TAKEN_BACK;
    if (instance.confirmTakenBackBy === press.userId) return null;
  }
  return pressWasTakenBack(press.pressedAt, instance.confirmTakenBackAt)
    ? PRESS_BEFORE_TAKE_BACK
    : null;
}

export function withTakenBackPressIds(
  ids: string[] | undefined,
  added: string[] | undefined,
): string[] | undefined {
  if (added === undefined || added.length === 0) return ids;
  return [...(ids ?? []), ...added].slice(-MAX_TAKEN_BACK_PRESS_IDS);
}

export function withConfirmPressId(ids: string[] | undefined, pressId: string): string[] {
  const list = ids ?? [];
  if (list.includes(pressId)) return list;
  if (list.length === 0) return [pressId];
  const others = [...list.slice(1), pressId].slice(-(MAX_CONFIRM_PRESS_IDS - 1));
  return [list[0]!, ...others];
}

export const SENIOR_UNDO_MS = 60_000;

export function isDoneState(state: InstanceState): boolean {
  return state === "confirmed" || state === "resolved";
}

export function seniorCanUndo(
  instance: Pick<
    Doc<"taskInstances">,
    "state" | "confirmedBy" | "confirmedAt" | "confirmReceivedAt"
  >,
  userId: string,
  now: number,
): boolean {
  const recordedAt = instance.confirmReceivedAt ?? instance.confirmedAt;
  return (
    instance.state === "confirmed" &&
    instance.confirmedBy === userId &&
    recordedAt !== undefined &&
    now - recordedAt <= SENIOR_UNDO_MS
  );
}

export function caregiverCanReopen(
  instance: Pick<Doc<"taskInstances">, "state" | "confirmedAt" | "localDate">,
  now: number,
  timezone: string,
): boolean {
  const today = localDate(now, timezone);
  return (
    isDoneState(instance.state) &&
    (instance.localDate === today ||
      (instance.confirmedAt !== undefined && localDate(instance.confirmedAt, timezone) === today))
  );
}

export function taskStillRuns(
  task: Pick<Doc<"tasks">, "active" | "type" | "times"> | null,
  instance: Pick<Doc<"taskInstances">, "scheduledTime">,
): boolean {
  if (task === null || !task.active) return false;
  if (isAnytimeInstance(instance)) return isAnytimeTask(task);
  return task.times.includes(instance.scheduledTime);
}

export function reopenedState(
  instance: Pick<
    Doc<"taskInstances">,
    "scheduledTime" | "windowStart" | "windowEnd" | "resolvedFromState"
  >,
  now: number,
): InstanceState {
  if (now < instance.windowStart) return "upcoming";
  if (now >= instance.windowEnd) return "missed";
  const prior = instance.resolvedFromState;
  if (!isAnytimeInstance(instance) && (prior === "due" || prior === "escalated")) return prior;
  return "due";
}
