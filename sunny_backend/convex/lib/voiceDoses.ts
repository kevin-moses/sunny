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
//   description. With no words, a scheduled medication due right now comes first (it better
//   explains "I took my pills": status scheduled_due, confirm that one); otherwise it is the only
//   as-needed one on file.
// - Repeat guard: when a dose of the same medication was reported in the last 30 minutes
//   (whatever time it claims), or one claims a time within 30 minutes of this one, nothing is
//   logged and already_logged gives that dose's time, so the model asks whether this is the same
//   dose or another. With `another`, the dose is logged anyway and the limits and flags apply.
//   The same tool call repeated (same conversation, within 2 minutes, the same claimed time) is
//   already_logged with repeatCall, which the agent passes on as logged without a question.
//   `another` always logs: it answers that question, typically within the same 2 minutes.
// - A dose past a limit (lib/doseLimits: the stricter of 24 hours and the calendar day, or too
//   soon) flags the caregiver with reason medication_limit, keyed on the task, so one
//   medication's flag never hides another's; the flag remembers the dose (agentFlags.doseId).
// - Repeated use: when the medication has been taken on at least 4 of the last 7 local days, a
//   repeated_use notice goes to the caregiver at most once a week per medication. It is not
//   part of the result, so it is not spoken to her.
// - Taking a dose back: only a dose logged by voice in this same conversation within the last
//   30 minutes. The row is kept, marked undoneAt, and every count leaves it out; undo_dose is
//   audited, and when the dose had raised a medication_limit flag the same caregivers get a
//   short correction.
// - Dose rows are read newest first, so the per-medication bound drops the oldest rows.
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
import { VOICE_AGENT, flagCaregiverCore, sendDoseCorrection } from "./voiceRouting";
import type { FlagResult } from "./voiceRouting";

/** A dose reported this recently (ms), or claiming a time this close, may be the same dose. */
const DOSE_REPEAT_WINDOW_MS = 30 * MINUTE_MS;
/** The same tool call repeated: same conversation, this recent (ms), the same claimed time. */
const REPEAT_CALL_MS = 2 * MINUTE_MS;
/** A voice dose can be taken back this long (ms) after it was logged. */
const UNDO_WINDOW_MS = 30 * MINUTE_MS;
/** Longest a self-reported dose may be back-dated ("I took one an hour ago"), in minutes. */
const MAX_DOSE_MINUTES_AGO = 12 * 60;
/** Repeated use: a notice once the medication was used on this many days... */
const REPEATED_USE_DAYS = 4;
/** ...of this many local days (today included)... */
const REPEATED_USE_WINDOW_DAYS = 7;
/** ...at most once in this long (ms) per medication. */
const REPEATED_USE_FLAG_REPEAT_MS = 7 * DAY_MS;
/** Doses read back this far (ms): the 7-day use count plus the 24-hour window, with margin. */
const DOSE_LOOKBACK_MS = (REPEATED_USE_WINDOW_DAYS + 2) * DAY_MS;
/** Most dose rows read per medication (the newest). */
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

/** An as-needed medication task with its recent dose rows (undone rows left out). */
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
    }
  | {
      status: "already_logged";
      medication: AsNeededEntry;
      /** The dose already written down. */
      takenAt: number;
      /** True when this is the same tool call repeated, not a new report to ask about. */
      repeatCall: boolean;
    }
  | { status: "no_rule" | "not_found" | "ambiguous" | "scheduled_due"; options: string[] };

/** Result of undoLastDoseCore. */
export type UndoDoseResult =
  | {
      status: "removed";
      displayLabel: string;
      takenAt: number;
      /** Caregivers told the dose was a mistake (it had raised a limit flag); else empty. */
      corrected: string[];
    }
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
 *          dose rows of the lookback: the newest MAX_DOSE_ROWS, undone rows left out, ascending.
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
    tasks.filter(isAsNeededTask).map(async (task) => {
      const newest = await ctx.db
        .query("doseLog")
        .withIndex("by_household_task_taken", (q) =>
          q
            .eq("householdId", household._id)
            .eq("taskId", task._id)
            .gte("takenAt", now - DOSE_LOOKBACK_MS),
        )
        .order("desc")
        .take(MAX_DOSE_ROWS);
      return { task, rows: newest.filter((r) => r.undoneAt === undefined).reverse() };
    }),
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
  if (words === "") {
    if (dueScheduled) return { status: "scheduled_due", options: [dueScheduled.displayLabel] };
    if (meds.length === 0) return { status: "no_rule", options };
    if (meds.length > 1) return { status: "ambiguous", options };
    return meds[0]!;
  }
  if (meds.length === 0) return { status: "no_rule", options };
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
 * purpose: When a dose was written down.
 * @param row: (Doc<"doseLog">) The dose.
 * @return: (number) loggedAt, or the creation time of a row from before that field.
 */
function loggedAt(row: Doc<"doseLog">): number {
  return row.loggedAt ?? row._creationTime;
}

/**
 * purpose: The dose already written down that this report may repeat (see the file header):
 *          one reported within DOSE_REPEAT_WINDOW_MS, or one claiming a time that close.
 * @param rows: (Doc<"doseLog">[]) The medication's dose rows.
 * @param takenAt: (number) The time this report claims, epoch ms.
 * @param now: (number) Epoch ms.
 * @return: (Doc<"doseLog"> | null) The newest such dose, or null.
 */
function possibleRepeat(
  rows: Doc<"doseLog">[],
  takenAt: number,
  now: number,
): Doc<"doseLog"> | null {
  const near = rows.filter(
    (r) =>
      loggedAt(r) >= now - DOSE_REPEAT_WINDOW_MS ||
      Math.abs(r.takenAt - takenAt) < DOSE_REPEAT_WINDOW_MS,
  );
  return near.reduce<Doc<"doseLog"> | null>(
    (a, b) => (a === null || loggedAt(b) > loggedAt(a) ? b : a),
    null,
  );
}

/**
 * purpose: Whether a possible repeat is the same tool call made again: logged in the same
 *          conversation within REPEAT_CALL_MS, claiming the same time (within REPEAT_CALL_MS).
 * @param row: (Doc<"doseLog">) The dose already written down.
 * @param takenAt: (number) The time this report claims, epoch ms.
 * @param conversationId: (Id<"conversations"> | undefined) This report's conversation.
 * @param now: (number) Epoch ms.
 * @return: (boolean) True for the same call repeated.
 */
function isRepeatCall(
  row: Doc<"doseLog">,
  takenAt: number,
  conversationId: Id<"conversations"> | undefined,
  now: number,
): boolean {
  return (
    conversationId !== undefined &&
    row.conversationId === conversationId &&
    loggedAt(row) >= now - REPEAT_CALL_MS &&
    Math.abs(row.takenAt - takenAt) <= REPEAT_CALL_MS
  );
}

/**
 * purpose: Log a dose the senior says they took (instances.logDoseCore, via voice) and return
 *          the label facts afterwards, flagging the caregiver past a limit and sending the
 *          repeated-use notice (see the file header). Nothing is logged without a matching
 *          rule, or when the report may repeat a dose already written down (unless `another`).
 * @param ctx: (MutationCtx) Context.
 * @param args: ({household, words, minutesAgo, another, dueScheduled, conversationId, now}) The
 *        household, lower-cased words naming the medication ("" for none), whole minutes since
 *        the dose (0..MAX_DOSE_MINUTES_AGO), whether she said it is another dose, a loader for
 *        the scheduled medication due now (awaited only when no words were given), the
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
    another: boolean;
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
  const dueScheduled = args.words === "" ? await args.dueScheduled() : null;
  const picked = pickAsNeeded(meds, args.words, dueScheduled);
  if ("status" in picked) return picked;
  const dayOf = householdDayOf(household);
  const takenAt = now - minutesAgo * MINUTE_MS;
  const repeat = possibleRepeat(picked.rows, takenAt, now);
  if (repeat && !args.another) {
    return {
      status: "already_logged",
      medication: asNeededEntry(picked, dayOf, now),
      takenAt: repeat.takenAt,
      repeatCall: isRepeatCall(repeat, takenAt, args.conversationId, now),
    };
  }
  const doses = picked.rows.map((r) => r.takenAt);
  const doseId = await logDoseCore(
    ctx,
    VOICE_AGENT,
    {
      householdId: household._id,
      taskId: picked.task._id,
      takenAt,
      via: "voice",
      conversationId: args.conversationId,
    },
    now,
  );
  const row = (await ctx.db.get(doseId))!;
  const medication = asNeededEntry({ ...picked, rows: [...picked.rows, row] }, dayOf, now);
  const breaches = limitBreaches(limitsOf(picked.task), doses, takenAt, dayOf);
  let flagStatus: FlagResult["status"] | null = null;
  let flagged: string[] = [];
  if (breaches.overDailyMax || breaches.tooSoon) {
    const flag = await flagCaregiverCore(ctx, {
      household,
      reason: "medication_limit",
      key: `medication_limit:${picked.task._id}`,
      detail: limitFlagDetail(household, picked, takenAt, breaches),
      doseId,
      conversationId: args.conversationId,
      now,
    });
    flagStatus = flag.status;
    flagged = flag.notified;
  }
  if (medication.daysUsedLast7 >= REPEATED_USE_DAYS) {
    await flagCaregiverCore(ctx, {
      household,
      reason: "repeated_use",
      subject: picked.task.displayLabel,
      key: `repeated_use:${picked.task._id}`,
      repeatWindowMs: REPEATED_USE_FLAG_REPEAT_MS,
      detail:
        `${household.seniorPreferredName} has taken ${picked.task.displayLabel} on ` +
        `${medication.daysUsedLast7} of the last ${REPEATED_USE_WINDOW_DAYS} days.`,
      conversationId: args.conversationId,
      now,
    });
  }
  return { status: "logged", medication, takenAt, ...breaches, flagStatus, flagged };
}

/**
 * purpose: Take back a dose she reported by voice in this conversation in the last 30 minutes
 *          ("no, I didn't take it"): mark it undone (every count leaves it out), audit
 *          undo_dose, and send a correction to the caregivers its limit flag reached. A dose
 *          from an earlier conversation, or one logged any other way, is never changed.
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
  const { household, now, conversationId } = args;
  const meds = await asNeededMeds(ctx, household, now);
  const options = meds.map((m) => m.task.displayLabel);
  if (meds.length === 0) return { status: "no_rule", options };
  const candidates = args.words === "" ? meds : matching(meds, args.words);
  if (candidates.length === 0) return { status: "not_found", options };
  const undoable = candidates.flatMap((m) =>
    m.rows
      .filter(
        (r) =>
          conversationId !== undefined &&
          r.conversationId === conversationId &&
          r.reportedVia === "voice" &&
          loggedAt(r) >= now - UNDO_WINDOW_MS,
      )
      .map((row) => ({ med: m, row })),
  );
  if (undoable.length === 0) return { status: "nothing_to_undo", options };
  const withDoses = new Set(undoable.map((d) => d.med.task._id));
  if (args.words !== "" && withDoses.size > 1) {
    return {
      status: "ambiguous",
      options: candidates.filter((m) => withDoses.has(m.task._id)).map((m) => m.task.displayLabel),
    };
  }
  const latest = undoable.reduce((a, b) => (loggedAt(b.row) > loggedAt(a.row) ? b : a));
  await ctx.db.patch(latest.row._id, { undoneAt: now });
  await audit(ctx, {
    householdId: household._id,
    actor: VOICE_AGENT,
    action: "undo_dose",
    entity: "doseLog",
    entityId: latest.row._id,
    detail: {
      taskId: latest.med.task._id,
      takenAt: latest.row.takenAt,
      conversationId: conversationId ?? null,
    },
  });
  const corrected = await sendDoseCorrection(ctx, {
    household,
    taskId: latest.med.task._id,
    doseId: latest.row._id,
    conversationId,
    now,
  });
  return {
    status: "removed",
    displayLabel: latest.med.task.displayLabel,
    takenAt: latest.row.takenAt,
    corrected,
  };
}
