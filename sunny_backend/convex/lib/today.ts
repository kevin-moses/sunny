import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { type Actor, memberNames } from "./access";
import { compareDayOrder } from "./anytime";
import { caregiverCanReopen, seniorCanConfirm, taskStillRuns } from "./confirmRule";
import { isSnoozed, seniorPromptCount } from "./escalation";
import { addDays, daysBetween, localDate, localTime } from "./time";
import type { ConfirmVia, InstanceState, TaskType } from "./validators";

export interface TodayEntry {
  instanceId: Id<"taskInstances">;
  localDate: string;
  carriedOver: boolean;
  taskId: Id<"tasks">;
  type: TaskType;
  displayLabel: string;
  spokenPrompt: string;
  pillDescription: string | null;
  checklistItems: string[];
  scheduledTime: string;
  state: InstanceState;
  confirmedAt: number | null;
  confirmedLocalTime: string | null;
  confirmedVia: ConfirmVia | null;
  confirmReceivedAt: number | null;
  confirmReceivedLocalTime: string | null;
  confirmReceivedDaysLater: number | null;
  claimedBy: string | null;
  claimedByName: string | null;
  confirmedBy: string | null;
  confirmedByName: string | null;
  resolutionNote: string | null;
  confirmable: boolean;
  reopenable: boolean;
  confirmPressIds: string[];
  seniorPrompts: number;
  snoozed: boolean;
  snoozedUntil: number | null;
}

export function receivedDaysLater(
  instance: { confirmedAt?: number; confirmReceivedAt?: number },
  timezone: string,
): number | null {
  if (instance.confirmedAt === undefined || instance.confirmReceivedAt === undefined) return null;
  return daysBetween(
    localDate(instance.confirmedAt, timezone),
    localDate(instance.confirmReceivedAt, timezone),
  );
}

function visibleConfirmPressIds(
  instance: Pick<Doc<"taskInstances">, "confirmedBy" | "confirmPressIds">,
  reader: Actor | null,
): string[] {
  return reader?.kind === "senior_device" && instance.confirmedBy === reader.userId
    ? (instance.confirmPressIds ?? [])
    : [];
}

export async function todayInstances(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
  reader: Actor | null,
): Promise<TodayEntry[]> {
  const household = await ctx.db.get(householdId);
  if (!household) return [];
  const date = localDate(now, household.timezone);
  const carryOver = (
    await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) =>
        q.eq("householdId", householdId).eq("localDate", addDays(date, -1)),
      )
      .collect()
  )
    .filter((i) => i.state === "due" || i.state === "escalated")
    .sort(compareDayOrder);
  const todays = (
    await ctx.db
      .query("taskInstances")
      .withIndex("by_household_date", (q) => q.eq("householdId", householdId).eq("localDate", date))
      .collect()
  ).sort(compareDayOrder);
  const carriedIds = new Set(carryOver.map((i) => i._id));
  const names = await memberNames(ctx, householdId);
  const nameOf = (userId: string | null): string | null =>
    userId === null ? null : (names.get(userId) ?? null);
  const entries: TodayEntry[] = [];
  for (const instance of [...carryOver, ...todays]) {
    const task = await ctx.db.get(instance.taskId);
    if (!task) continue;
    const claimedBy = instance.claimedBy ?? null;
    const confirmedBy = instance.confirmedBy ?? null;
    const confirmedAt = instance.confirmedAt ?? null;
    entries.push({
      instanceId: instance._id,
      localDate: instance.localDate,
      carriedOver: carriedIds.has(instance._id),
      taskId: task._id,
      type: task.type,
      displayLabel: task.displayLabel,
      spokenPrompt: task.spokenPrompt,
      pillDescription: task.pillDescription ?? null,
      checklistItems: task.checklistItems,
      scheduledTime: instance.scheduledTime,
      state: instance.state,
      confirmedAt,
      confirmedLocalTime: confirmedAt === null ? null : localTime(confirmedAt, household.timezone),
      confirmedVia: instance.confirmedVia ?? null,
      confirmReceivedAt: instance.confirmReceivedAt ?? null,
      confirmReceivedLocalTime:
        instance.confirmReceivedAt === undefined
          ? null
          : localTime(instance.confirmReceivedAt, household.timezone),
      confirmReceivedDaysLater: receivedDaysLater(instance, household.timezone),
      claimedBy,
      claimedByName: nameOf(claimedBy),
      confirmedBy,
      confirmedByName: instance.state === "resolved" ? nameOf(confirmedBy) : null,
      resolutionNote: instance.resolutionNote ?? null,
      confirmable: seniorCanConfirm(instance, now),
      reopenable:
        caregiverCanReopen(instance, now, household.timezone) && taskStillRuns(task, instance),
      confirmPressIds: visibleConfirmPressIds(instance, reader),
      seniorPrompts: seniorPromptCount(instance.firedSteps),
      snoozed: isSnoozed(instance.snoozedUntil, now),
      snoozedUntil: instance.snoozedUntil ?? null,
    });
  }
  return entries;
}
