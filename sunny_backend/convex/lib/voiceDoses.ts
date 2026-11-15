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

const DOSE_REPEAT_WINDOW_MS = 30 * MINUTE_MS;
const REPEAT_CALL_MS = 2 * MINUTE_MS;
const UNDO_WINDOW_MS = 30 * MINUTE_MS;
const MAX_DOSE_MINUTES_AGO = 12 * 60;
const REPEATED_USE_DAYS = 4;
const REPEATED_USE_WINDOW_DAYS = 7;
const REPEATED_USE_FLAG_REPEAT_MS = 7 * DAY_MS;
const DOSE_LOOKBACK_MS = (REPEATED_USE_WINDOW_DAYS + 2) * DAY_MS;
const MAX_DOSE_ROWS = 300;

export interface AsNeededEntry {
  taskId: Id<"tasks">;
  displayLabel: string;
  pillDescription: string | null;
  maxPerDay: number | null;
  minHoursBetween: number | null;
  takenToday: number[];
  takenLast24h: number[];
  lastTakenAt: number | null;
  remainingToday: number | null;
  nextWithinLabelAt: number | null;
  daysUsedLast7: number;
}

interface AsNeededMed {
  task: Doc<"tasks">;
  rows: Doc<"doseLog">[];
}

export type LogDoseResult =
  | {
      status: "logged";
      medication: AsNeededEntry;
      takenAt: number;
      overDailyMax: boolean;
      tooSoon: boolean;
      count: number;
      flagStatus: FlagResult["status"] | null;
      flagged: string[];
    }
  | {
      status: "already_logged";
      medication: AsNeededEntry;
      takenAt: number;
      repeatCall: boolean;
    }
  | { status: "no_rule" | "not_found" | "ambiguous" | "scheduled_due"; options: string[] };

export type UndoDoseResult =
  | {
      status: "removed";
      displayLabel: string;
      takenAt: number;
      corrected: string[];
    }
  | { status: "nothing_to_undo" | "no_rule" | "not_found" | "ambiguous"; options: string[] };

function householdDayOf(household: Doc<"households">): DayOf {
  const tz = household.timezone;
  return (t) => dayRange(localDate(t, tz), tz);
}

function limitsOf(task: Doc<"tasks">): DoseLimits {
  return {
    maxPerDay: task.asNeededMaxPerDay ?? null,
    minHoursBetween: task.asNeededMinHours ?? null,
  };
}

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

export async function asNeededEntries(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<AsNeededEntry[]> {
  const dayOf = householdDayOf(household);
  return (await asNeededMeds(ctx, household, now)).map((m) => asNeededEntry(m, dayOf, now));
}

function matching(meds: AsNeededMed[], words: string): AsNeededMed[] {
  return meds.filter((m) =>
    [m.task.displayLabel, m.task.title, m.task.pillDescription ?? ""].some((text) =>
      text.toLowerCase().includes(words),
    ),
  );
}

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

function possibleRepeat(
  rows: Doc<"doseLog">[],
  takenAt: number,
  now: number,
): Doc<"doseLog"> | null {
  const near = rows.filter(
    (r) =>
      r.loggedAt >= now - DOSE_REPEAT_WINDOW_MS ||
      Math.abs(r.takenAt - takenAt) < DOSE_REPEAT_WINDOW_MS,
  );
  return near.reduce<Doc<"doseLog"> | null>(
    (a, b) => (a === null || b.loggedAt > a.loggedAt ? b : a),
    null,
  );
}

function isRepeatCall(
  row: Doc<"doseLog">,
  takenAt: number,
  conversationId: Id<"conversations"> | undefined,
  now: number,
): boolean {
  return (
    conversationId !== undefined &&
    row.conversationId === conversationId &&
    row.loggedAt >= now - REPEAT_CALL_MS &&
    Math.abs(row.takenAt - takenAt) <= REPEAT_CALL_MS
  );
}

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
          r.loggedAt >= now - UNDO_WINDOW_MS,
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
  const latest = undoable.reduce((a, b) => (b.row.loggedAt > a.row.loggedAt ? b : a));
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
