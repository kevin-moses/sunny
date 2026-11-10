// lib/voiceDoses.ts
// Purpose: As-needed medication for the voice agent (agent.ts): the facts it reads aloud, the
// self-reported dose ("I took a Tylenol") and taking one back ("no, I didn't take it"). The
// label arithmetic is lib/doseLimits.ts; this module reads and writes doseLog and raises the
// caregiver flags.
//
// Rules:
// - An as-needed medication is what tasks.isAsNeededTask says (a medication with no scheduled
//   times and a limit on file); a scheduled medication that happens to carry limits never is.
// - Which one the senior means: words matching its display label, caregiver title or pill
//   description. With no words it is the only one on file, unless a scheduled medication is due
//   right now, which better explains "I took my pills" (status scheduled_due: confirm that one).
// - A dose of the same medication within 30 minutes of the reported time is the same dose told
//   again (or a retried call): nothing is logged and already_logged gives that dose's time.
// - A dose past a limit (lib/doseLimits: the stricter of 24 hours and the calendar day, or too
//   soon) flags the caregiver with reason medication_limit, keyed on the task, so one
//   medication's flag never hides another's.
// - Repeated use: when the medication has been taken on at least 4 of the last 7 local days, a
//   symptom flag says so, at most once a week per medication.
// - Taking a dose back removes the most recent voice-reported dose of that medication from
//   today, audited as undo_dose; a flag already sent is not withdrawn.
//
// Last modified: 2026-11-09

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isAsNeededTask } from "../tasks";
import { logDoseCore } from "../instances";
import { audit } from "./audit";
import { daysUsed, doseStatus, limitBreaches } from "./doseLimits";
import { appError } from "./errors";
import type { DayOf, DoseLimits, LimitBreaches } from "./doseLimits";
import { DAY_MS, MINUTE_MS, dayRange, formatTime12, localDate, localTime } from "./time";
import type { TodayEntry } from "./today";
import { VOICE_AGENT, flagCaregiverCore } from "./voiceRouting";
import type { FlagResult } from "./voiceRouting";

/** A dose of the same medication this close (ms) to a reported one is the same dose. */
const DOSE_REPEAT_WINDOW_MS = 30 * MINUTE_MS;
/** Longest a self-reported dose may be back-dated ("I took one an hour ago"), in minutes. */
const MAX_DOSE_MINUTES_AGO = 12 * 60;
/** Repeated use: a symptom flag once the medication was used on this many days... */
const REPEATED_USE_DAYS = 4;
/** ...of this many local days (today included)... */
const REPEATED_USE_WINDOW_DAYS = 7;
/** ...at most once in this long (ms) per medication. */
const REPEATED_USE_FLAG_REPEAT_MS = 7 * DAY_MS;
/** Doses read back this far (ms): the 7-day use count plus the 24-hour window, with margin. */
const DOSE_LOOKBACK_MS = (REPEATED_USE_WINDOW_DAYS + 2) * DAY_MS;
/** Most dose rows read per medication. */
const MAX_DOSE_ROWS = 300;

/** One as-needed medication with its doses and what the label limits mean right now. */
export interface AsNeededEntry {
  taskId: Id<"tasks">;
  displayLabel: string;
  pillDescription: string | null;
  /** The label's maximum, applied to any 24 hours and to the local day. */
  maxPerDay: number | null;
  minHoursBetween: number | null;
  /** Doses since local midnight, ascending. */
  takenToday: number[];
  /** Doses in the trailing 24 hours, ascending. */
  takenLast24h: number[];
  /** The latest dose; null when none in the lookback. */
  lastTakenAt: number | null;
  /** Doses left under the maximum (stricter count); null without a maximum. */
  remainingToday: number | null;
  /** Earliest instant another dose is within the label; null when it already is. */
  nextWithinLabelAt: number | null;
  /** Local days with a dose among the last 7, today included. */
  daysUsedLast7: number;
}

/** An as-needed medication task with its recent dose rows. */
interface AsNeededMed {
  task: Doc<"tasks">;
  /** Dose rows in the lookback, ascending by takenAt. */
  rows: Doc<"doseLog">[];
}

/** Result of logAsNeededDoseCore. */
export type LogDoseResult =
  | {
      status: "logged";
      medication: AsNeededEntry;
      takenAt: number;
      overDailyMax: boolean;
      tooSoon: boolean;
      /** Doses in its local day or any 24 hours containing it, this one included. */
      count: number;
      /** The limit flag's status, or null when the dose is within the label. */
      flagStatus: FlagResult["status"] | null;
      /** Caregivers a limit flag was queued for (or already reached); empty otherwise. */
      flagged: string[];
      /** Caregivers a repeated-use flag was queued for by this dose; empty otherwise. */
      repeatedUseFlagged: string[];
    }
  | { status: "already_logged"; medication: AsNeededEntry; takenAt: number }
  | { status: "no_rule" | "not_found" | "ambiguous" | "scheduled_due"; options: string[] };

/** Result of undoLastDoseCore. */
export type UndoDoseResult =
  | { status: "removed"; displayLabel: string; takenAt: number }
  | { status: "nothing_to_undo" | "no_rule" | "not_found" | "ambiguous"; options: string[] };

/**
 * purpose: The household-local day of any instant, for the limit arithmetic.
 * @param household: (Doc<"households">) The household.
 * @return: (DayOf) Instant to its local midnight and the next local midnight.
 */
function householdDayOf(household: Doc<"households">): DayOf {
  const tz = household.timezone;
  return (t) => dayRange(localDate(t, tz), tz);
}

/**
 * purpose: The label limits of a task.
 * @param task: (Doc<"tasks">) The as-needed task.
 * @return: (DoseLimits) maxPerDay and minHoursBetween, null when not on file.
 */
function limitsOf(task: Doc<"tasks">): DoseLimits {
  return {
    maxPerDay: task.asNeededMaxPerDay ?? null,
    minHoursBetween: task.asNeededMinHours ?? null,
  };
}

/**
 * purpose: The household's active as-needed medications (tasks.isAsNeededTask), each with its
 *          dose rows of the lookback.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<AsNeededMed[]>) In task creation order.
 */
async function asNeededMeds(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<AsNeededMed[]> {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_household_active", (q) => q.eq("householdId", household._id).eq("active", true))
    .collect();
  return await Promise.all(
    tasks.filter(isAsNeededTask).map(async (task) => ({
      task,
      rows: await ctx.db
        .query("doseLog")
        .withIndex("by_household_task_taken", (q) =>
          q
            .eq("householdId", household._id)
            .eq("taskId", task._id)
            .gte("takenAt", now - DOSE_LOOKBACK_MS),
        )
        .take(MAX_DOSE_ROWS),
    })),
  );
}

/**
 * purpose: The agent's view of one as-needed medication at an instant.
 * @param med: (AsNeededMed) The task and its dose rows.
 * @param dayOf: (DayOf) The household's local day of an instant.
 * @param now: (number) Epoch ms.
 * @return: (AsNeededEntry) The entry.
 */
function asNeededEntry(med: AsNeededMed, dayOf: DayOf, now: number): AsNeededEntry {
  const limits = limitsOf(med.task);
  const doses = med.rows.map((r) => r.takenAt);
  return {
    taskId: med.task._id,
    displayLabel: med.task.displayLabel,
    pillDescription: med.task.pillDescription ?? null,
    ...limits,
    ...doseStatus(limits, doses, dayOf, now),
    daysUsedLast7: daysUsed(doses, dayOf, now, REPEATED_USE_WINDOW_DAYS),
  };
}

/**
 * purpose: Every as-needed medication's facts right now.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<AsNeededEntry[]>) Entries in task creation order.
 */
export async function asNeededEntries(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<AsNeededEntry[]> {
  const dayOf = householdDayOf(household);
  return (await asNeededMeds(ctx, household, now)).map((m) => asNeededEntry(m, dayOf, now));
}

/**
 * purpose: The as-needed medications whose label, title or pill description contains words.
 * @param meds: (AsNeededMed[]) The medications.
 * @param words: (string) Lower-cased, trimmed words.
 * @return: (AsNeededMed[]) The matches.
 */
function matching(meds: AsNeededMed[], words: string): AsNeededMed[] {
  return meds.filter((m) =>
    [m.task.displayLabel, m.task.title, m.task.pillDescription ?? ""].some((text) =>
      text.toLowerCase().includes(words),
    ),
  );
}

/**
 * purpose: Pick the as-needed medication the senior means (see the file header).
 * @param meds: (AsNeededMed[]) The household's as-needed medications.
 * @param words: (string) Lower-cased words, or "" for none.
 * @param dueScheduled: (TodayEntry | null) A scheduled medication due right now, if any.
 * @return: (AsNeededMed | LogDoseResult) The medication, or the no_rule, not_found, ambiguous
 *          or scheduled_due result.
 */
function pickAsNeeded(
  meds: AsNeededMed[],
  words: string,
  dueScheduled: TodayEntry | null,
): AsNeededMed | Extract<LogDoseResult, { options: string[] }> {
  const options = meds.map((m) => m.task.displayLabel);
  if (meds.length === 0) return { status: "no_rule", options };
  if (words === "") {
    if (meds.length > 1) return { status: "ambiguous", options };
    if (dueScheduled) return { status: "scheduled_due", options: [dueScheduled.displayLabel] };
    return meds[0]!;
  }
  const matches = matching(meds, words);
  if (matches.length === 0) return { status: "not_found", options };
  if (matches.length > 1) {
    return { status: "ambiguous", options: matches.map((m) => m.task.displayLabel) };
  }
  return matches[0]!;
}

/**
 * purpose: The two sentences a caregiver gets when a self-reported dose goes past a label
 *          limit (flag details are capped at two sentences, so both breaches share the second).
 * @param household: (Doc<"households">) The household.
 * @param med: (AsNeededMed) The medication.
 * @param takenAt: (number) The dose, epoch ms.
 * @param breaches: (LimitBreaches) Which limits it went past and the count.
 * @return: (string) For example "Margaret reported taking Pain reliever at 3:10 PM. That is 4
 *          in 24 hours, over the label's 3 in 24 hours."
 */
function limitFlagDetail(
  household: Doc<"households">,
  med: AsNeededMed,
  takenAt: number,
  breaches: LimitBreaches,
): string {
  const limits: string[] = [];
  if (breaches.overDailyMax) {
    limits.push(
      `${breaches.count} in 24 hours, over the label's ${med.task.asNeededMaxPerDay} in 24 hours`,
    );
  }
  if (breaches.tooSoon) {
    limits.push(`less than the label's ${med.task.asNeededMinHours} hours from another dose`);
  }
  const at = formatTime12(localTime(takenAt, household.timezone));
  return (
    `${household.seniorPreferredName} reported taking ${med.task.displayLabel} at ${at}. ` +
    `That is ${limits.join(", and ")}.`
  );
}

/**
 * purpose: Log a dose the senior says they took (instances.logDoseCore, via voice) and return
 *          the label facts afterwards, flagging the caregiver past a limit and on repeated use
 *          (see the file header). Nothing is logged without a matching rule, or when the same
 *          dose was already logged.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, words, minutesAgo, dueScheduled, conversationId, now}) The
 *        household, lower-cased words naming the medication ("" for none), whole minutes since
 *        the dose (0..MAX_DOSE_MINUTES_AGO), a loader for the scheduled medication due now
 *        (awaited only when it can matter: no words and one as-needed medication), the
 *        conversation and the clock.
 * @return: (Promise<LogDoseResult>) The outcome.
 * @raises invalid for minutesAgo outside 0..720 or not whole.
 */
export async function logAsNeededDoseCore(
  ctx: MutationCtx,
  args: {
    household: Doc<"households">;
    words: string;
    minutesAgo: number;
    dueScheduled: () => Promise<TodayEntry | null>;
    conversationId?: Id<"conversations">;
    now: number;
  },
): Promise<LogDoseResult> {
  const { household, now, minutesAgo } = args;
  if (!Number.isInteger(minutesAgo) || minutesAgo < 0 || minutesAgo > MAX_DOSE_MINUTES_AGO) {
    throw appError("invalid", "minutesAgo must be a whole number from 0 to 720");
  }
  const meds = await asNeededMeds(ctx, household, now);
  const dueScheduled = args.words === "" && meds.length === 1 ? await args.dueScheduled() : null;
  const picked = pickAsNeeded(meds, args.words, dueScheduled);
  if ("status" in picked) return picked;
  const dayOf = householdDayOf(household);
  const takenAt = now - args.minutesAgo * MINUTE_MS;
  const doses = picked.rows.map((r) => r.takenAt);
  const same = doses.find((d) => Math.abs(d - takenAt) < DOSE_REPEAT_WINDOW_MS);
  if (same !== undefined) {
    return {
      status: "already_logged",
      medication: asNeededEntry(picked, dayOf, now),
      takenAt: same,
    };
  }
  const doseId = await logDoseCore(
    ctx,
    VOICE_AGENT,
    { householdId: household._id, taskId: picked.task._id, takenAt, via: "voice" },
    now,
  );
  const row = (await ctx.db.get(doseId))!;
  const after: AsNeededMed = { ...picked, rows: [...picked.rows, row] };
  const breaches = limitBreaches(limitsOf(picked.task), doses, takenAt, dayOf);
  let flagStatus: FlagResult["status"] | null = null;
  let flagged: string[] = [];
  if (breaches.overDailyMax || breaches.tooSoon) {
    const flag = await flagCaregiverCore(ctx, {
      household,
      reason: "medication_limit",
      key: `medication_limit:${picked.task._id}`,
      detail: limitFlagDetail(household, picked, takenAt, breaches),
      conversationId: args.conversationId,
      now,
    });
    flagStatus = flag.status;
    flagged = flag.notified;
  }
  const medication = asNeededEntry(after, dayOf, now);
  let repeatedUseFlagged: string[] = [];
  if (medication.daysUsedLast7 >= REPEATED_USE_DAYS) {
    const flag = await flagCaregiverCore(ctx, {
      household,
      reason: "symptom",
      key: `repeated_use:${picked.task._id}`,
      repeatWindowMs: REPEATED_USE_FLAG_REPEAT_MS,
      detail:
        `${household.seniorPreferredName} has taken ${picked.task.displayLabel} on ` +
        `${medication.daysUsedLast7} of the last ${REPEATED_USE_WINDOW_DAYS} days.`,
      conversationId: args.conversationId,
      now,
    });
    if (flag.status === "flagged") repeatedUseFlagged = flag.notified;
  }
  return {
    status: "logged",
    medication,
    takenAt,
    ...breaches,
    flagStatus,
    flagged,
    repeatedUseFlagged,
  };
}

/**
 * purpose: Take back the most recent voice-reported dose of today ("no, I didn't take it"):
 *          delete it and audit undo_dose. A flag the dose raised is not withdrawn.
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, words, conversationId, now}) The household, lower-cased words
 *        naming the medication ("" for whichever was reported last), the conversation and the
 *        clock.
 * @return: (Promise<UndoDoseResult>) removed with the dose, or why nothing was removed.
 */
export async function undoLastDoseCore(
  ctx: MutationCtx,
  args: {
    household: Doc<"households">;
    words: string;
    conversationId?: Id<"conversations">;
    now: number;
  },
): Promise<UndoDoseResult> {
  const { household, now } = args;
  const meds = await asNeededMeds(ctx, household, now);
  const options = meds.map((m) => m.task.displayLabel);
  if (meds.length === 0) return { status: "no_rule", options };
  const candidates = args.words === "" ? meds : matching(meds, args.words);
  if (candidates.length === 0) return { status: "not_found", options };
  const today = householdDayOf(household)(now);
  const voiceToday = candidates.flatMap((m) =>
    m.rows
      .filter((r) => r.reportedVia === "voice" && r.takenAt >= today.start && r.takenAt <= now)
      .map((row) => ({ med: m, row })),
  );
  if (voiceToday.length === 0) return { status: "nothing_to_undo", options };
  const withDoses = new Set(voiceToday.map((d) => d.med.task._id));
  if (args.words !== "" && withDoses.size > 1) {
    return {
      status: "ambiguous",
      options: candidates.filter((m) => withDoses.has(m.task._id)).map((m) => m.task.displayLabel),
    };
  }
  const latest = voiceToday.reduce((a, b) => (b.row.takenAt > a.row.takenAt ? b : a));
  await ctx.db.delete(latest.row._id);
  await audit(ctx, {
    householdId: household._id,
    actor: VOICE_AGENT,
    action: "undo_dose",
    entity: "doseLog",
    entityId: latest.row._id,
    detail: {
      taskId: latest.med.task._id,
      takenAt: latest.row.takenAt,
      conversationId: args.conversationId ?? null,
    },
  });
  return {
    status: "removed",
    displayLabel: latest.med.task.displayLabel,
    takenAt: latest.row.takenAt,
  };
}
