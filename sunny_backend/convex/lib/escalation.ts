// lib/escalation.ts
// Purpose: When an escalation step fires, in one place, so the scheduler (scheduler.ts, which
// fires the steps) and the device state (lib/deviceState.ts, which tells a device when the policy
// will next send the senior a prompt so an offline device can chime on its own clock) cannot
// drift. A step is due once the clock reaches the later of the instance's windowStart and
// createdAt, plus the step's offset (stepDueAt). A due step is held back while a snooze holds
// senior prompts (isSnoozed), and a skipIfClaimed step for as long as the instance is claimed
// (stepHeld). Only an active task with a policy has steps (activePolicySteps). Open states are
// upcoming, due and escalated (isOpenState); seniorPromptCount counts the prompts already sent,
// caregiverAlerted says whether a caregiver alert went out (the scheduler, the digest facts and
// the on-call migration share it), firedStep builds the record of a fired step, and
// dueOrEscalatedInstances reads a household's instances the scheduler fires and closes (due
// first, then escalated).
// upcomingPromptTimes projects those rules forward: the instants at which the scheduler will
// send a senior prompt for an instance that stays unconfirmed, assuming nothing else changes
// (no new snooze, no claim, no policy edit). Like the scheduler, only open timed instances
// prompt (anytime instances never do), a step already fired never fires again, nothing fires
// once the window has ended, and steps of one kind that come due together send one prompt (so
// equal instants are listed once). The scheduler ticks once a minute, so the prompt itself goes
// out at the first tick at or after a listed instant (up to a minute later).
//
// Last modified: 2026-11-14

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isAnytimeInstance } from "./anytime";
import { minutes } from "./time";
import { isCaregiverAlert } from "./validators";
import type { EscalationAction, EscalationStep, InstanceState } from "./validators";

/** One fired-step record on an instance. */
export type FiredStep = Doc<"taskInstances">["firedSteps"][number];

/** The instance fields that decide when a step is due and whether it is held back. */
export interface StepTiming {
  windowStart: number;
  createdAt: number;
  /** When the latest snooze ends; absent or null when never snoozed. */
  snoozedUntil?: number | null;
  /** Who claimed the instance ("I'm on it"); absent or null when unclaimed. */
  claimedBy?: string | null;
}

/** The instance fields upcomingPromptTimes reads. */
export interface PromptTiming extends StepTiming {
  state: InstanceState;
  scheduledTime: string;
  windowEnd: number;
  firedSteps: readonly { stepId: string }[];
}

/**
 * purpose: Whether an instance state is still open (waiting to be done).
 * @param state: (InstanceState) The state.
 * @return: (boolean) True for upcoming, due and escalated.
 */
export function isOpenState(state: InstanceState): boolean {
  return state === "upcoming" || state === "due" || state === "escalated";
}

/**
 * purpose: Whether a snooze ("not yet") holds the senior prompts at `now`.
 * @param snoozedUntil: (number | null | undefined) When the latest snooze ends.
 * @param now: (number) Epoch ms.
 * @return: (boolean) True while now is before snoozedUntil.
 */
export function isSnoozed(snoozedUntil: number | null | undefined, now: number): boolean {
  return snoozedUntil != null && now < snoozedUntil;
}

/**
 * purpose: Whether a caregiver alert went out for an instance: a fired caregiver-alert step
 *          (the legacy "alert_on_call" counts) that was notified.
 * @param firedSteps: (readonly { action, notified }[]) The instance's fired steps.
 * @return: (boolean) True when caregivers were alerted.
 */
export function caregiverAlerted(
  firedSteps: readonly { action: EscalationAction; notified: boolean }[],
): boolean {
  return firedSteps.some((s) => isCaregiverAlert(s.action) && s.notified);
}

/**
 * purpose: The record of a step fired at an instant.
 * @param step: (EscalationStep) The step.
 * @param now: (number) Epoch ms it fired.
 * @param notified: (boolean) Whether it sent anything (false when superseded in the same tick).
 * @return: (FiredStep) The record for the instance's firedSteps.
 */
export function firedStep(step: EscalationStep, now: number, notified: boolean): FiredStep {
  return { stepId: step.id, action: step.action, firedAt: now, notified };
}

/**
 * purpose: A household's instances whose window the scheduler fires steps on or closes: those
 *          due, then those escalated, through the by_household_state index.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"taskInstances">[]>) The due instances, then the escalated ones.
 */
export async function dueOrEscalatedInstances(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"taskInstances">[]> {
  const rows: Doc<"taskInstances">[] = [];
  for (const state of ["due", "escalated"] as const) {
    rows.push(
      ...(await ctx.db
        .query("taskInstances")
        .withIndex("by_household_state", (q) => q.eq("householdId", householdId).eq("state", state))
        .collect()),
    );
  }
  return rows;
}

/**
 * purpose: How many senior prompts the policy has sent for an instance: fired prompt_senior
 *          steps that were notified (a step superseded in the same tick sent nothing).
 * @param firedSteps: (readonly { action, notified }[]) The instance's fired steps.
 * @return: (number) The count.
 */
export function seniorPromptCount(
  firedSteps: readonly { action: EscalationAction; notified: boolean }[],
): number {
  return firedSteps.filter((s) => s.action === "prompt_senior" && s.notified).length;
}

/**
 * purpose: The escalation steps a task can fire: its policy's steps when the task exists, is
 *          active and has a policy that exists.
 * @param ctx: (QueryCtx) Context.
 * @param task: (Doc<"tasks"> | null) The task.
 * @return: (Promise<EscalationStep[] | null>) The steps, or null when nothing can fire.
 */
export async function activePolicySteps(
  ctx: QueryCtx,
  task: Doc<"tasks"> | null,
): Promise<EscalationStep[] | null> {
  if (!task || !task.active || task.escalationPolicyId === undefined) return null;
  return (await ctx.db.get(task.escalationPolicyId))?.steps ?? null;
}

/**
 * purpose: The instant a step becomes due on an instance: offsets count from the later of the
 *          window start and the instance's creation (a task added after its window opened
 *          counts from when it was added).
 * @param instance: (StepTiming) The instance's windowStart and createdAt.
 * @param step: (Pick<EscalationStep, "offsetMinutes">) The step.
 * @return: (number) Epoch ms.
 */
export function stepDueAt(
  instance: StepTiming,
  step: Pick<EscalationStep, "offsetMinutes">,
): number {
  return Math.max(instance.windowStart, instance.createdAt) + minutes(step.offsetMinutes);
}

/**
 * purpose: Whether a due step is held back at `now`: a senior prompt while a snooze holds the
 *          prompts ("not yet"), and a skipIfClaimed step once someone claimed the instance.
 * @param instance: (StepTiming) The instance's snoozedUntil and claimedBy.
 * @param step: (Pick<EscalationStep, "action" | "skipIfClaimed">) The step.
 * @param now: (number) Epoch ms.
 * @return: (boolean) True when the step must wait (or, when claimed, never fires).
 */
export function stepHeld(
  instance: StepTiming,
  step: Pick<EscalationStep, "action" | "skipIfClaimed">,
  now: number,
): boolean {
  if (step.action === "prompt_senior" && isSnoozed(instance.snoozedUntil, now)) return true;
  return step.skipIfClaimed && instance.claimedBy != null;
}

/**
 * purpose: The first instant a step can fire: when it is due, or when the snooze holding it
 *          ends if that is later.
 * @param instance: (StepTiming) The instance.
 * @param step: (EscalationStep) The step.
 * @return: (number | null) Epoch ms, or null when it is held for good (claimed).
 */
function firstFireAt(instance: StepTiming, step: EscalationStep): number | null {
  let at = stepDueAt(instance, step);
  if (stepHeld(instance, step, at) && instance.snoozedUntil != null) {
    at = Math.max(at, instance.snoozedUntil);
  }
  return stepHeld(instance, step, at) ? null : at;
}

/**
 * purpose: The instants in (from, to] at which the scheduler will send a senior prompt for an
 *          instance that stays unconfirmed: each unfired prompt_senior step at its first fire
 *          time, before the window ends, equal instants once, ascending.
 * @param instance: (PromptTiming) The instance.
 * @param steps: (readonly EscalationStep[]) The task's policy steps (activePolicySteps); empty
 *        when nothing can fire.
 * @param from: (number) Epoch ms, exclusive (normally now).
 * @param to: (number) Epoch ms, inclusive (the end of the horizon).
 * @return: (number[]) Epoch ms instants.
 */
export function upcomingPromptTimes(
  instance: PromptTiming,
  steps: readonly EscalationStep[],
  from: number,
  to: number,
): number[] {
  if (!isOpenState(instance.state) || isAnytimeInstance(instance)) return [];
  const fired = new Set(instance.firedSteps.map((f) => f.stepId));
  const times = new Set<number>();
  for (const step of steps) {
    if (step.action !== "prompt_senior" || fired.has(step.id)) continue;
    const at = firstFireAt(instance, step);
    if (at !== null && at > from && at <= to && at < instance.windowEnd) times.add(at);
  }
  return [...times].sort((a, b) => a - b);
}
