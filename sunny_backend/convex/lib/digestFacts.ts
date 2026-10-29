// lib/digestFacts.ts
// Purpose: Gather the facts of one household-local day for the daily digest, from logged data
// only (see notes/SPEC.md "Daily digest"): task instances of that local date that were
// confirmed (with time and how), resolved by a caregiver, missed, or escalated (with who
// claimed them), as-needed doses taken that day, and the senior's questions asked that day
// (unanswered, routed to family, and repeat counts by topic). "That day" is the household's
// local day, from local midnight to the next local midnight, so a DST day is 23 or 25 hours
// long and a zone far from UTC still gets its own calendar day. Nothing from other days is
// read. Lists are capped so a busy day stays within one query.
//
// Last modified: 2026-10-29

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { addDays, formatTime12, localTime, zonedInstant } from "./time";
import type { ConfirmVia } from "./validators";

/** The most task instances, questions and doses read for one day. */
const DAY_READ_CAP = 200;

/** How a logged task instance ended its day. */
export type TaskOutcome = "confirmed" | "resolved" | "missed" | "escalated";

/** One task instance of the day. */
export interface TaskFact {
  label: string;
  /** 12-hour scheduled time. */
  scheduledAt: string;
  outcome: TaskOutcome;
  /** 12-hour time it was confirmed or resolved. */
  doneAt?: string;
  via?: ConfirmVia;
  /** Caregiver who resolved it on the senior's behalf. */
  resolvedBy?: string;
  claimedBy?: string;
  /** A caregiver alert was sent for it. */
  alerted: boolean;
}

/** As-needed doses of one task taken that day. */
export interface DoseFact {
  label: string;
  /** 12-hour times, in order. */
  times: string[];
}

/** A topic the senior asked about more than once. */
export interface RepeatFact {
  topic: string;
  count: number;
}

/** Everything the digest says about one day. */
export interface DigestFacts {
  seniorName: string;
  localDate: string;
  tasks: TaskFact[];
  doses: DoseFact[];
  questionCount: number;
  unanswered: string[];
  routed: string[];
  repeats: RepeatFact[];
}

/**
 * purpose: The instant range [start, end) of a household-local day.
 * @param localDate: (string) "YYYY-MM-DD".
 * @param timezone: (string) IANA zone.
 * @return: ({ start: number; end: number }) Local midnight to the next local midnight.
 */
export function dayRange(localDate: string, timezone: string): { start: number; end: number } {
  return {
    start: zonedInstant(localDate, "00:00", timezone),
    end: zonedInstant(addDays(localDate, 1), "00:00", timezone),
  };
}

/**
 * purpose: Map a user id to a caregiver's display name.
 * @param names: (Map<string, string>) Member names by user id.
 * @param userId: (string | undefined) The user id.
 * @return: (string | undefined) The name, "a caregiver" for an unknown user, or undefined.
 */
function nameOf(names: Map<string, string>, userId: string | undefined): string | undefined {
  return userId === undefined ? undefined : (names.get(userId) ?? "a caregiver");
}

/**
 * purpose: The task facts of the local day: confirmed, resolved, missed and escalated
 *          instances (upcoming and merely due ones are not logged outcomes).
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param localDate: (string) The local day.
 * @param names: (Map<string, string>) Member names by user id.
 * @return: (Promise<TaskFact[]>) Facts ordered by scheduled time.
 */
async function taskFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  localDate: string,
  names: Map<string, string>,
): Promise<TaskFact[]> {
  const instances = await ctx.db
    .query("taskInstances")
    .withIndex("by_household_date", (q) =>
      q.eq("householdId", household._id).eq("localDate", localDate),
    )
    .take(DAY_READ_CAP);
  const logged = instances.filter(
    (i) =>
      i.state === "confirmed" ||
      i.state === "resolved" ||
      i.state === "missed" ||
      i.state === "escalated",
  );
  logged.sort((a, b) => a.windowStart - b.windowStart);
  const labels = new Map<Id<"tasks">, string | null>();
  const facts: TaskFact[] = [];
  for (const instance of logged) {
    if (!labels.has(instance.taskId)) {
      labels.set(instance.taskId, (await ctx.db.get(instance.taskId))?.displayLabel ?? null);
    }
    const label = labels.get(instance.taskId);
    if (label === null || label === undefined) continue;
    const state = instance.state as TaskOutcome;
    const fact: TaskFact = {
      label,
      scheduledAt: formatTime12(instance.scheduledTime),
      outcome: state,
      alerted: instance.firedSteps.some((f) => f.notified && f.action !== "prompt_senior"),
    };
    if (instance.confirmedAt !== undefined) {
      fact.doneAt = formatTime12(localTime(instance.confirmedAt, household.timezone));
    }
    if (instance.confirmedVia !== undefined) fact.via = instance.confirmedVia;
    if (state === "resolved") fact.resolvedBy = nameOf(names, instance.confirmedBy);
    const claimedBy = nameOf(names, instance.claimedBy);
    if (claimedBy !== undefined) fact.claimedBy = claimedBy;
    facts.push(fact);
  }
  return facts;
}

/**
 * purpose: The as-needed doses taken in the day, grouped by task.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param range: ({ start: number; end: number }) The day's instants.
 * @return: (Promise<DoseFact[]>) One fact per task with doses that day.
 */
async function doseFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  range: { start: number; end: number },
): Promise<DoseFact[]> {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_household", (q) => q.eq("householdId", household._id))
    .collect();
  const facts: DoseFact[] = [];
  for (const task of tasks.filter((t) => t.times.length === 0)) {
    const doses = await ctx.db
      .query("doseLog")
      .withIndex("by_household_task_taken", (q) =>
        q
          .eq("householdId", household._id)
          .eq("taskId", task._id)
          .gte("takenAt", range.start)
          .lt("takenAt", range.end),
      )
      .take(DAY_READ_CAP);
    if (doses.length > 0) {
      facts.push({
        label: task.displayLabel,
        times: doses.map((d) => formatTime12(localTime(d.takenAt, household.timezone))),
      });
    }
  }
  return facts;
}

/**
 * purpose: The question facts of the day: how many were asked, which went unanswered
 *          ("unsure") or were routed to family, and topics asked more than once.
 * @param questions: (Doc<"agentQuestions">[]) The day's questions.
 * @return: (Pick<DigestFacts, "questionCount" | "unanswered" | "routed" | "repeats">) Facts.
 */
export function questionFacts(
  questions: Doc<"agentQuestions">[],
): Pick<DigestFacts, "questionCount" | "unanswered" | "routed" | "repeats"> {
  const counts = new Map<string, number>();
  for (const q of questions) {
    const topic = q.topic.trim().toLowerCase();
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  const repeats = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
  const topicsWith = (outcome: string): string[] => [
    ...new Set(
      questions
        .filter((q) => q.outcome === outcome)
        .map((q) => q.question.trim().replace(/[.?!\s]+$/, "")),
    ),
  ];
  return {
    questionCount: questions.length,
    unanswered: topicsWith("unsure"),
    routed: topicsWith("routed"),
    repeats,
  };
}

/**
 * purpose: Gather every fact for a household's local day.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param localDate: (string) The local day, "YYYY-MM-DD".
 * @return: (Promise<DigestFacts>) The facts.
 */
export async function gatherDigestFacts(
  ctx: QueryCtx,
  household: Doc<"households">,
  localDate: string,
): Promise<DigestFacts> {
  const range = dayRange(localDate, household.timezone);
  const members = await ctx.db
    .query("householdMembers")
    .withIndex("by_household_user", (q) => q.eq("householdId", household._id))
    .collect();
  const names = new Map(members.map((m) => [m.userId, m.displayName]));
  const questions = await ctx.db
    .query("agentQuestions")
    .withIndex("by_household_asked", (q) =>
      q.eq("householdId", household._id).gte("askedAt", range.start).lt("askedAt", range.end),
    )
    .take(DAY_READ_CAP);
  return {
    seniorName: household.seniorPreferredName,
    localDate,
    tasks: await taskFacts(ctx, household, localDate, names),
    doses: await doseFacts(ctx, household, range),
    ...questionFacts(questions),
  };
}
