// lib/agentBriefing.ts
// Purpose: The household briefing the agent receives at the start of each request, ported
// from the Supabase agent runtime: the senior's preferred name, the timezone, the local
// weekday and date/time now, the requesting caregiver's display name, and the calendar for
// today and the next 7 days (one line per occurrence with its event_id so the model can
// change or cancel it), and the household's active tasks, one compact line each with its
// type, times, weekdays and today's state per time (so the agent can answer "did she take
// her pills"). Built on the calendar's householdWeek helper so the week matches the day
// view.
//
// Last modified: 2026-11-01

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { householdWeek } from "../calendar";
import { listTasksCore } from "../tasks";
import { findMember } from "./access";
import { localDateTime, WEEKDAY_NAMES } from "./time";

/** Most tasks listed in the briefing; the rest are left to the get_tasks tool. */
const MAX_BRIEFING_TASKS = 30;

/**
 * purpose: One compact briefing line for a task: label, type, when it runs and today's state
 *          per time, e.g. "- Morning pills (medication) at 08:00, 20:00 every day; today: 08:00
 *          confirmed, 20:00 upcoming".
 * @param task: (Doc<"tasks">) An active task.
 * @param todays: (Doc<"taskInstances">[]) Today's instances of that task.
 * @return: (string) The line.
 */
function taskLine(task: Doc<"tasks">, todays: Doc<"taskInstances">[]): string {
  const days = task.daysOfWeek?.map((d) => WEEKDAY_NAMES[d - 1]!.slice(0, 3).toLowerCase());
  const when = task.onceOn
    ? `only on ${task.onceOn}`
    : days
      ? `on ${days.join(", ")}`
      : "every day";
  const times = task.times.length ? `at ${task.times.join(", ")}` : "as needed";
  const states = [...todays]
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime))
    .map((i) => `${i.scheduledTime} ${i.state}`);
  const today = states.length ? `today: ${states.join(", ")}` : "nothing today";
  return `- ${task.displayLabel} (${task.type}) ${times} ${when}; ${today}`;
}

/**
 * purpose: The briefing's task lines: the household's active tasks with today's instance
 *          states, at most MAX_BRIEFING_TASKS.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param today: (string) The household's local date.
 * @return: (Promise<string[]>) Lines, or a single "(none)" line.
 */
async function taskLines(
  ctx: QueryCtx,
  householdId: Id<"households">,
  today: string,
): Promise<string[]> {
  const tasks = (await listTasksCore(ctx, householdId)).filter((t) => t.active);
  if (tasks.length === 0) return ["  (none)"];
  const instances = await ctx.db
    .query("taskInstances")
    .withIndex("by_household_date", (q) => q.eq("householdId", householdId).eq("localDate", today))
    .collect();
  const lines = tasks.slice(0, MAX_BRIEFING_TASKS).map((t) =>
    taskLine(
      t,
      instances.filter((i) => i.taskId === t._id),
    ),
  );
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
  const { household, today, weekday, week } = await householdWeek(ctx, householdId, now);
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
    ...(await taskLines(ctx, householdId, today)),
  ].join("\n");
}
