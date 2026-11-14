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
// offline press is recorded with an earlier confirmedAt. caregiverCanReopen: an editor
// caregiver may reopen a confirmed or resolved instance whose confirmedAt falls on the
// household-local date of `now` (the home display has no undo). reopenedState says which state
// a reopened (or an unrecorded undone) instance gets from the clock alone.
//
// Last modified: 2026-11-13

import { isAnytimeInstance } from "./anytime";
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
  const done = instance.state === "confirmed" || instance.state === "resolved";
  return !done && notTooEarly(instance, now);
}

/** How long (ms) after the server recorded a senior device's confirm that device may undo it. */
export const SENIOR_UNDO_MS = 60_000;

/** The instance fields seniorCanUndo reads. */
export interface UndoRuleInput {
  state: InstanceState;
  confirmedBy?: string;
  confirmedAt?: number;
  confirmReceivedAt?: number;
}

/**
 * purpose: Whether a senior device may take back its own confirm now: the instance is confirmed
 *          (not resolved by a caregiver), the confirm is this device's own, and the server
 *          recorded it at most SENIOR_UNDO_MS ago. Recorded means confirmReceivedAt when set (an
 *          offline press), else confirmedAt.
 * @param instance: (UndoRuleInput) The instance's state, confirmer and confirm times.
 * @param userId: (string) The device account asking.
 * @param now: (number) Epoch ms.
 * @return: (boolean) True when the undo is allowed.
 */
export function seniorCanUndo(instance: UndoRuleInput, userId: string, now: number): boolean {
  const recordedAt = instance.confirmReceivedAt ?? instance.confirmedAt;
  return (
    instance.state === "confirmed" &&
    instance.confirmedBy === userId &&
    recordedAt !== undefined &&
    now - recordedAt <= SENIOR_UNDO_MS
  );
}

/** The instance fields caregiverCanReopen reads. */
export interface ReopenRuleInput {
  state: InstanceState;
  confirmedAt?: number;
}

/**
 * purpose: Whether an editor caregiver may reopen the instance now (the role is checked by the
 *          caller): it is confirmed or resolved, by anyone, and its confirmedAt is on the same
 *          household-local date as `now`.
 * @param instance: (ReopenRuleInput) The instance's state and confirmedAt.
 * @param now: (number) Epoch ms.
 * @param timezone: (string) The household's IANA zone.
 * @return: (boolean) True when the instance may be reopened.
 */
export function caregiverCanReopen(
  instance: ReopenRuleInput,
  now: number,
  timezone: string,
): boolean {
  const done = instance.state === "confirmed" || instance.state === "resolved";
  return (
    done &&
    instance.confirmedAt !== undefined &&
    localDate(instance.confirmedAt, timezone) === localDate(now, timezone)
  );
}

/** The instance fields reopenedState reads. */
export interface ReopenStateInput {
  scheduledTime: string;
  windowStart: number;
  windowEnd: number;
  resolvedFromState?: InstanceState;
}

/**
 * purpose: The open state an instance gets when its confirmation is taken away, by the clock:
 *          before windowStart it is upcoming; at or after windowEnd it is missed; inside the
 *          window it is the recorded prior state when that was due or escalated, else due.
 *          An anytime instance (lib/anytime.ts) never escalates, so inside its window it is
 *          always due.
 * @param instance: (ReopenStateInput) Window, scheduledTime and the recorded prior state.
 * @param now: (number) Epoch ms.
 * @return: (InstanceState) upcoming, due, escalated or missed.
 */
export function reopenedState(instance: ReopenStateInput, now: number): InstanceState {
  if (now < instance.windowStart) return "upcoming";
  if (now >= instance.windowEnd) return "missed";
  const prior = instance.resolvedFromState;
  if (!isAnytimeInstance(instance) && (prior === "due" || prior === "escalated")) return prior;
  return "due";
}
