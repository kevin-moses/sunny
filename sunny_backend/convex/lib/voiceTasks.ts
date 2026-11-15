import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { snoozeInstance } from "../instances";
import { isDueEntry, pickDueEntry } from "./dueTask";
import { todayInstances } from "./today";
import type { TodayEntry } from "./today";
import { asNeededEntries } from "./voiceDoses";
import type { AsNeededEntry } from "./voiceDoses";
import { VOICE_AGENT } from "./voiceRouting";

export interface MedicationStatus {
  scheduled: TodayEntry[];
  asNeeded: AsNeededEntry[];
}

export interface SnoozeResult {
  status: "snoozed" | "nothing_due" | "not_found" | "ambiguous" | "already_done" | "not_due_yet";
  displayLabel: string | null;
  scheduledTime: string | null;
  snoozedUntil: number | null;
  confirmedAt: number | null;
  options: string[];
}

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

export async function dueScheduledMedication(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<TodayEntry | null> {
  const entries = await todayInstances(ctx, householdId, now);
  return entries.find((e) => e.type === "medication" && isDueEntry(e)) ?? null;
}

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
