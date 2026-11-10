// lib/voiceTasks.ts
// Purpose: The voice agent's view of today's tasks beyond "Done" (which is
// instances.confirmDueTaskCore): "not yet" (snoozeDueTaskCore, the task picked exactly as "Done"
// picks it, lib/dueTask, and snoozed through instances.snoozeInstance by its default 15
// minutes; caregiver alerts are not delayed), the facts for a medication question
// (medicationStatusCore: today's scheduled medications and the as-needed label facts), and the
// scheduled medication that is due right now (which explains an unnamed "I took my pills"
// better than an as-needed dose does).
//
// Last modified: 2026-11-09

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { snoozeInstance } from "../instances";
import { isDueEntry, pickDueEntry } from "./dueTask";
import { todayInstances } from "./today";
import type { TodayEntry } from "./today";
import { asNeededEntries } from "./voiceDoses";
import type { AsNeededEntry } from "./voiceDoses";
import { VOICE_AGENT } from "./voiceRouting";

/** Result of a medication question's facts. */
export interface MedicationStatus {
  /** Today's scheduled medication entries (see lib/today). */
  scheduled: TodayEntry[];
  asNeeded: AsNeededEntry[];
}

/** Result of "not yet". */
export interface SnoozeResult {
  status: "snoozed" | "nothing_due" | "not_found" | "ambiguous" | "already_done" | "not_due_yet";
  displayLabel: string | null;
  scheduledTime: string | null;
  snoozedUntil: number | null;
  confirmedAt: number | null;
  options: string[];
}

/**
 * purpose: Build a SnoozeResult.
 * @param status: (SnoozeResult["status"]) The outcome.
 * @param entry: (Partial<TodayEntry> | null) The entry it is about, if one.
 * @param extra: (Partial<SnoozeResult>) Fields to set.
 * @return: (SnoozeResult) The result with every other field null or empty.
 */
function snoozeResult(
  status: SnoozeResult["status"],
  entry: Partial<TodayEntry> | null,
  extra: Partial<SnoozeResult> = {},
): SnoozeResult {
  return {
    status,
    displayLabel: entry?.displayLabel ?? null,
    scheduledTime: entry?.scheduledTime ?? null,
    snoozedUntil: null,
    confirmedAt: entry?.confirmedAt ?? null,
    options: [],
    ...extra,
  };
}

/**
 * purpose: "Not yet": snooze the prompts of the task "Done" would mean. A matching task already
 *          done reports when; one still upcoming reports not_due_yet; a missed one, or none,
 *          reports nothing_due.
 * @param ctx: (MutationCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param label: (string | null | undefined) Words from the task's label as said, if any.
 * @param now: (number) Epoch ms.
 * @return: (Promise<SnoozeResult>) The outcome and the task it was about.
 */
export async function snoozeDueTaskCore(
  ctx: MutationCtx,
  householdId: Id<"households">,
  label: string | null | undefined,
  now: number,
): Promise<SnoozeResult> {
  const picked = pickDueEntry(await todayInstances(ctx, householdId, now), label);
  if (!("entry" in picked)) {
    return snoozeResult(picked.status, picked.status === "already_done" ? picked : null, {
      options: (picked.options ?? []).map((e) => e.displayLabel),
    });
  }
  const { entry } = picked;
  if (!isDueEntry(entry)) {
    return entry.state === "upcoming"
      ? snoozeResult("not_due_yet", entry)
      : snoozeResult("nothing_due", null);
  }
  const row = await snoozeInstance(ctx, VOICE_AGENT, { instanceId: entry.instanceId }, now);
  return snoozeResult("snoozed", entry, { snoozedUntil: row.snoozedUntil ?? null });
}

/**
 * purpose: The first scheduled medication of today that is due right now.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<TodayEntry | null>) The entry, or null when none is due.
 */
export async function dueScheduledMedication(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<TodayEntry | null> {
  const entries = await todayInstances(ctx, householdId, now);
  return entries.find((e) => e.type === "medication" && isDueEntry(e)) ?? null;
}

/**
 * purpose: The facts for a medication question, read fresh.
 * @param ctx: (QueryCtx) Context.
 * @param household: (Doc<"households">) The household.
 * @param now: (number) Epoch ms.
 * @return: (Promise<MedicationStatus>) Scheduled and as-needed facts.
 */
export async function medicationStatusCore(
  ctx: QueryCtx,
  household: Doc<"households">,
  now: number,
): Promise<MedicationStatus> {
  const entries = await todayInstances(ctx, household._id, now);
  return {
    scheduled: entries.filter((e) => e.type === "medication"),
    asNeeded: await asNeededEntries(ctx, household, now),
  };
}
