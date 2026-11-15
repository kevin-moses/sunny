import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isAnytimeInstance, isAnytimeTask } from "./anytime";
import { minutes } from "./time";
import type { EscalationAction, InstanceState } from "./validators";

export type FiredStep = Doc<"taskInstances">["firedSteps"][number];

export interface EscalationStep {
  id: string;
  offsetMinutes: number;
  action: EscalationAction;
}

export const PROMPT_AGAIN_MINUTES = 15;

export const ALERT_MINUTES = 30;

const PROMPT_STEP: EscalationStep = { id: "prompt", offsetMinutes: 0, action: "prompt_senior" };

export const ESCALATION_LADDER: readonly EscalationStep[] = [
  PROMPT_STEP,
  { id: "prompt_again", offsetMinutes: PROMPT_AGAIN_MINUTES, action: "prompt_senior" },
  { id: "alert", offsetMinutes: ALERT_MINUTES, action: "alert_all_caregivers" },
];

export const PROMPT_ONLY_LADDER: readonly EscalationStep[] = [PROMPT_STEP];

type LadderTask = Pick<Doc<"tasks">, "type" | "times" | "highPriority">;

export function isCaregiverAlert(action: FiredStep["action"]): boolean {
  return action !== "prompt_senior";
}

export function isHighPriority(task: Pick<Doc<"tasks">, "highPriority">): boolean {
  return task.highPriority === true;
}

export function alertsCaregivers(task: LadderTask): boolean {
  return !isAnytimeTask(task) && (task.type === "medication" || isHighPriority(task));
}

export function escalationSteps(
  task: (LadderTask & Pick<Doc<"tasks">, "active">) | null,
): readonly EscalationStep[] {
  if (!task || !task.active || isAnytimeTask(task)) return [];
  return alertsCaregivers(task) ? ESCALATION_LADDER : PROMPT_ONLY_LADDER;
}

export interface StepTiming {
  windowStart: number;
  createdAt: number;
  snoozedUntil?: number | null;
}

export interface PromptTiming extends StepTiming {
  state: InstanceState;
  scheduledTime: string;
  windowEnd: number;
  firedSteps: readonly { stepId: string }[];
}

export function isOpenState(state: InstanceState): boolean {
  return state === "upcoming" || state === "due" || state === "escalated";
}

export function isSnoozed(snoozedUntil: number | null | undefined, now: number): boolean {
  return snoozedUntil != null && now < snoozedUntil;
}

export function caregiverAlerted(
  firedSteps: readonly Pick<FiredStep, "action" | "notified">[],
): boolean {
  return firedSteps.some((s) => isCaregiverAlert(s.action) && s.notified);
}

export function firedStep(step: EscalationStep, now: number, notified: boolean): FiredStep {
  return { stepId: step.id, action: step.action, firedAt: now, notified };
}

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

export function seniorPromptCount(
  firedSteps: readonly Pick<FiredStep, "action" | "notified">[],
): number {
  return firedSteps.filter((s) => s.action === "prompt_senior" && s.notified).length;
}

export function stepDueAt(
  instance: StepTiming,
  step: Pick<EscalationStep, "offsetMinutes">,
): number {
  return Math.max(instance.windowStart, instance.createdAt) + minutes(step.offsetMinutes);
}

export function stepHeld(
  instance: StepTiming,
  step: Pick<EscalationStep, "action">,
  now: number,
): boolean {
  return step.action === "prompt_senior" && isSnoozed(instance.snoozedUntil, now);
}

function firstFireAt(instance: StepTiming, step: EscalationStep): number | null {
  let at = stepDueAt(instance, step);
  if (stepHeld(instance, step, at) && instance.snoozedUntil != null) {
    at = Math.max(at, instance.snoozedUntil);
  }
  return stepHeld(instance, step, at) ? null : at;
}

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
