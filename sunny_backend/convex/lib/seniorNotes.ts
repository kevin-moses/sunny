import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

const MAX_SHOWN = 3;
const MAX_SCANNED = 50;

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
    .withIndex("by_household_expires", (q) => q.eq("householdId", householdId).gt("expiresAt", now))
    .take(MAX_SCANNED);
  return rows
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, MAX_SHOWN)
    .map((row) => ({
      id: row._id,
      text: row.text,
      receivedAt: row.receivedAt,
      expiresAt: row.expiresAt,
    }));
}
