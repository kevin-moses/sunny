import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { DAY_MS, addDays, localDate, zonedInstant } from "./time";

const MAX_SHOWN = 3;
const LONGEST_NOTE_LIFE_MS = 3 * DAY_MS;

export function noteExpiry(receivedAt: number, timezone: string): number {
  return zonedInstant(addDays(localDate(receivedAt, timezone), 2), "00:00", timezone);
}

export interface SeniorNoteView {
  id: Id<"seniorNotes">;
  text: string;
  receivedAt: number;
  expiresAt: number;
}

export async function activeSeniorNotes(
  ctx: QueryCtx,
  householdId: Id<"households">,
  now: number,
): Promise<SeniorNoteView[]> {
  const rows = await ctx.db
    .query("seniorNotes")
    .withIndex("by_household_received", (q) =>
      q.eq("householdId", householdId).gt("receivedAt", now - LONGEST_NOTE_LIFE_MS),
    )
    .order("desc")
    .collect();
  return rows
    .filter((row) => row.expiresAt > now)
    .slice(0, MAX_SHOWN)
    .map((row) => ({
      id: row._id,
      text: row.text,
      receivedAt: row.receivedAt,
      expiresAt: row.expiresAt,
    }));
}
