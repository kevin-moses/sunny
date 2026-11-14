// lib/confirmRule.ts
// Purpose: The rule for when the senior's devices may confirm a task instance, in one place so
// the confirm mutation (instances.confirmInstance) and the day view's per-task `confirmable`
// flag (lib/today.ts) cannot drift. A senior device may confirm an open instance in any state
// except that an upcoming one must start within EARLY_CONFIRM_MS: the distance is measured from
// the instance's windowStart (local midnight for an anytime instance, which is never upcoming
// in practice). Snoozing does not change it (a snoozed instance is still due), and due,
// escalated and missed instances can always be confirmed (missed ones late). Done instances are
// not confirmable (confirming them changes nothing).
//
// The two ways back out of a confirm live here too, for the same reason. seniorCanUndo: a senior
// device may take back its own confirm for SENIOR_UNDO_MS after the server recorded it (the app
// offers Undo for 30 s; the server allows 60 s so a slow network never refuses a press the
// senior was still offered), measured from confirmReceivedAt when there is one because an
// offline press is recorded with an earlier confirmedAt (a press that took 1 to 5 minutes to
// arrive has no confirmReceivedAt and lands already past the window; accepted, the phone's own
// Undo has expired by then). caregiverCanReopen: an editor caregiver may reopen a confirmed or
// resolved instance whose confirmedAt falls on the household-local date of `now`, or that is
// one of today's tasks (a 00:30 task confirmed at 23:45 the evening before); the home display
// has no undo. reopenedState says which state a reopened (or an unrecorded undone) instance
// gets from the clock alone.
//
// Last modified: 2026-11-13

import type { Doc } from "../_generated/dataModel";
import { isAnytimeInstance, isAnytimeTask } from "./anytime";
import { localDate, minutes } from "./time";
import type { InstanceState } from "./validators";

/** How long (ms) before its window starts an upcoming instance may already be confirmed. */
export const EARLY_CONFIRM_MS = minutes(60);

/** A confirm recorded this much (ms) before the server received it counts as late-synced. */
export const LATE_SYNC_MS = minutes(5);

/**
 * How long (ms) after its window ended a replayed press may still be recorded for the instance.
 * Generous enough for a task done a little late, short enough that a stale card pressed the
 * next morning is not recorded as last night's dose.
 */
export const REPLAY_GRACE_MS = minutes(180);

/** The instance fields the rule reads. */
export interface ConfirmRuleInput {
  state: InstanceState;
  windowStart: number;
}

/**
 * purpose: Whether the instance is not too early for a senior device to confirm at `now`
 *          (the check the confirm mutation applies; done instances pass here and are handled
 *          by the caller).
 * @param instance: (ConfirmRuleInput) The instance's state and window start.
 * @param now: (number) Epoch ms.
 * @return: (boolean) False only for an upcoming instance whose window starts more than
 *          EARLY_CONFIRM_MS from now.
 */
export function notTooEarly(instance: ConfirmRuleInput, now: number): boolean {
  return !(instance.state === "upcoming" && instance.windowStart - now > EARLY_CONFIRM_MS);
}

/**
 * purpose: Whether confirming the instance now would change it: it is open and not too early.
 * @param instance: (ConfirmRuleInput) The instance's state and window start.
 * @param now: (number) Epoch ms.
 * @return: (boolean) True for an open instance a senior device may confirm.
 */
export function seniorCanConfirm(instance: ConfirmRuleInput, now: number): boolean {
  return !isDoneState(instance.state) && notTooEarly(instance, now);
}

/** How long (ms) after the server recorded a senior device's confirm that device may undo it. */
export const SENIOR_UNDO_MS = 60_000;

/**
 * purpose: Whether a state is a done one (confirmed by a device or the agent, or resolved by a
 *          caregiver).
 * @param state: (InstanceState) The instance's state.
 * @return: (boolean) True for confirmed and resolved.
 */
export function isDoneState(state: InstanceState): boolean {
  return state === "confirmed" || state === "resolved";
}

/**
 * purpose: Whether a senior device may take back its own confirm now: the instance is confirmed
 *          (not resolved by a caregiver), the confirm is this device's own, and the server
 *          recorded it at most SENIOR_UNDO_MS ago. Recorded means confirmReceivedAt when set (a
 *          press held offline for more than LATE_SYNC_MS), else confirmedAt. A press that took
 *          between one and LATE_SYNC_MS to arrive has no confirmReceivedAt, so it is already
 *          past the window when it lands; that is accepted, because the phone's own 30 second
 *          Undo has expired by then.
 * @param instance: (Pick<Doc<"taskInstances">, "state" | "confirmedBy" | "confirmedAt" |
 *        "confirmReceivedAt">) The instance's state, confirmer and confirm times.
 * @param userId: (string) The device account asking.
 * @param now: (number) Epoch ms.
 * @return: (boolean) True when the undo is allowed.
 */
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

/**
 * purpose: Whether an editor caregiver may reopen the instance now (the role is checked by the
 *          caller): it is confirmed or resolved, by anyone, and it belongs to today's list: its
 *          confirmedAt is on the household-local date of `now`, or the instance's own local date
 *          is (a task confirmed up to 60 minutes early, or a press replayed after midnight, for a
 *          task of today).
 * @param instance: (Pick<Doc<"taskInstances">, "state" | "confirmedAt" | "localDate">) The
 *        instance's state, confirmedAt and own local date.
 * @param now: (number) Epoch ms.
 * @param timezone: (string) The household's IANA zone.
 * @return: (boolean) True when the instance may be reopened.
 */
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

/**
 * purpose: Whether the instance's task still runs the way the instance was made: the task
 *          exists, is active, and is still timed with the instance's time among its times, or
 *          still anytime to match an anytime instance. Deactivating a task, or switching it
 *          between timed and anytime or to other times, removes only its open instances, so a
 *          confirmed or resolved instance of such a task survives as history; putting it back
 *          to open would prompt for a task that no longer runs, or sit next to the row that
 *          replaced it. Used by the reopen and senior undo mutations and by the day view's
 *          `reopenable` flag so they agree.
 * @param task: (Pick<Doc<"tasks">, "active" | "type" | "times"> | null) The instance's task, or
 *        null when it is gone.
 * @param instance: (Pick<Doc<"taskInstances">, "scheduledTime">) The instance.
 * @return: (boolean) True when reopening the instance would match the schedule.
 */
export function taskStillRuns(
  task: Pick<Doc<"tasks">, "active" | "type" | "times"> | null,
  instance: Pick<Doc<"taskInstances">, "scheduledTime">,
): boolean {
  if (task === null || !task.active) return false;
  if (isAnytimeInstance(instance)) return isAnytimeTask(task);
  return !isAnytimeTask(task) && task.times.includes(instance.scheduledTime);
}

/**
 * purpose: The open state an instance gets when its confirmation is taken away, by the clock:
 *          before windowStart it is upcoming; at or after windowEnd it is missed; inside the
 *          window it is the recorded prior state when that was due or escalated, else due.
 *          An anytime instance (lib/anytime.ts) never escalates, so inside its window it is
 *          always due.
 * @param instance: (Pick<Doc<"taskInstances">, "scheduledTime" | "windowStart" | "windowEnd" |
 *        "resolvedFromState">) Window, scheduledTime and the recorded prior state.
 * @param now: (number) Epoch ms.
 * @return: (InstanceState) upcoming, due, escalated or missed.
 */
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
