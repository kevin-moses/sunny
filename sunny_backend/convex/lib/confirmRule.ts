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
// Last modified: 2026-11-09

import { minutes } from "./time";
import type { InstanceState } from "./validators";

/** How long (ms) before its window starts an upcoming instance may already be confirmed. */
export const EARLY_CONFIRM_MS = minutes(60);

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
