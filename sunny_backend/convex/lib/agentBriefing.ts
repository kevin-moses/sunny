// lib/agentBriefing.ts
// Purpose: The household briefing the agent receives at the start of each request, ported
// from the Supabase agent runtime: the senior's preferred name, the timezone, the local
// weekday and date/time now, the requesting caregiver's display name, and the calendar for
// today and the next 7 days (one line per occurrence with its event_id so the model can
// change or cancel it), and the household's active tasks, one terse line each with its
// task_id, type, times, weekdays and today's state per time (so the agent can answer "did she
// take her pills" and change or stop a task without a lookup). Built on the calendar's
// householdWeek helper so the week matches the day view, and on lib/today.ts todayInstances
// so task status is the canonical "today": it includes yesterday's still-open carry-over,
// and says when and by whom a confirmed instance was done.
//
// Last modified: 2026-11-01

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { householdWeek } from "../calendar";
import { listTasksCore } from "../tasks";
import { findMember } from "./access";
import { localDateTime, weekdayCodes } from "./time";
import { todayInstances } from "./today";
import type { TodayEntry } from "./today";

/** Most tasks listed in the briefing; the rest are left to the get_tasks tool. */
const MAX_BRIEFING_TASKS = 30;

/**
 * purpose: One instance as briefing text: "08:00 confirmed at 08:04", "08:00 resolved at 09:10
 *          by Anna" or "yesterday 23:30 due" for a carry-over.
 * @param entry: (TodayEntry) One of today's instances.
 * @return: (string) The text.
 */
function instanceText(entry: TodayEntry): string {
  const day = entry.carriedOver ? "yesterday " : "";
  const at = entry.confirmedLocalTime ? ` at ${entry.confirmedLocalTime}` : "";
  const by = entry.confirmedByName ? ` by ${entry.confirmedByName}` : "";
  return `${day}${entry.scheduledTime} ${entry.state}${at}${by}`;
}

/**
 * purpose: One terse briefing line for a task: label, type, id, when it runs and today's state
 *          per time, e.g. "- Morning pills (medication, task_id k1) at 08:00, 20:00 every day;
 *          today: 08:00 confirmed at 08:04, 20:00 upcoming".
 * @param task: (Doc<"tasks">) An active task.
 * @param todays: (TodayEntry[]) Today's entries of that task, in window order.
 * @return: (string) The line.
 */
function taskLine(task: Doc<"tasks">, todays: TodayEntry[]): string {
  const days = weekdayCodes(task.daysOfWeek);
  const when = task.onceOn
    ? `only on ${task.onceOn}`
    : days
      ? `on ${days.join(", ")}`
      : "every day";
  const times = task.times.length ? `at ${task.times.join(", ")}` : "as needed";
  const today = todays.length ? `today: ${todays.map(instanceText).join(", ")}` : "nothing today";
  return `- ${task.displayLabel} (${task.type}, task_id ${task._id}) ${times} ${when}; ${today}`;
}

/**
 * purpose: The briefing's task lines: the household's active tasks with today's instance
 *          states (carry-over included), at most MAX_BRIEFING_TASKS.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<string[]>) Lines, or a single "(none)" line.
 */
async function taskLines(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<string[]> {
  const tasks = await listTasksCore(ctx, householdId, true);
  if (tasks.length === 0) return ["  (none)"];
  const byTask = new Map<Id<"tasks">, TodayEntry[]>();
  for (const entry of await todayInstances(ctx, householdId, now)) {
    byTask.set(entry.taskId, [...(byTask.get(entry.taskId) ?? []), entry]);
  }
  const lines = tasks.slice(0, MAX_BRIEFING_TASKS).map((t) => taskLine(t, byTask.get(t._id) ?? []));
  if (tasks.length > MAX_BRIEFING_TASKS) {
    lines.push(`  (and ${tasks.length - MAX_BRIEFING_TASKS} more; use get_tasks)`);
  }
  return lines;
}

/**
 * purpose: Build the household briefing text for an agent request.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param requestedBy: (string | null) Clerk user id of the requesting caregiver, if any.
 * @param now: (number) Epoch ms.
 * @return: (Promise<string>) Briefing text, one fact per line.
 */
export async function buildBriefing(
  ctx: QueryCtx,
  householdId: Id<"households">,
  requestedBy: string | null,
  now: number,
): Promise<string> {
  const { household, weekday, week } = await householdWeek(ctx, householdId, now);
  const member = requestedBy === null ? null : await findMember(ctx, householdId, requestedBy);
  const events = week.map(
    (o) => `- ${o.localDate} ${o.event.startTime} ${o.event.title} (event_id ${o.event._id})`,
  );
  return [
    "Household briefing (from Sunny's records):",
    `- Senior: ${household.seniorPreferredName}`,
    `- Timezone: ${household.timezone}`,
    `- Now: ${weekday}, ${localDateTime(now, household.timezone)} local`,
    `- Requested by: ${member?.displayName ?? "a caregiver"}`,
    "- Calendar, today and the next 7 days:",
    ...(events.length ? events : ["  (nothing scheduled)"]),
    "- Active tasks, with today's status:",
    ...(await taskLines(ctx, householdId, now)),
  ].join("\n");
}
