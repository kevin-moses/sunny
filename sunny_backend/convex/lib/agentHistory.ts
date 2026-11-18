import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { memberNames } from "./access";
import { joinLines } from "./text";

export const MAX_EXCHANGES = 10;
export const MAX_TEXT_CHARS = 500;
export const MAX_SECTION_CHARS = 6000;

export const CARRY_OVER_HEADING = "Earlier in this conversation (most recent last):";
export const MAX_NAME_CHARS = 60;
export const UNKNOWN_AUTHOR = "A caregiver";

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3)}...`;
}

function authorLabel(names: Map<string, string>, userId: string): string {
  const collapsed = (names.get(userId) ?? "").replace(/\s+/g, " ").replace(/:/g, "");
  const name = clip(collapsed, MAX_NAME_CHARS);
  return !name || name.toLowerCase() === "sunny" ? UNKNOWN_AUTHOR : name;
}

export async function buildCarryOver(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<string> {
  const rows = await ctx.db
    .query("agentRequests")
    .withIndex("by_household_status", (q) =>
      q.eq("householdId", householdId).eq("status", "succeeded"),
    )
    .order("desc")
    .take(MAX_EXCHANGES);
  const names = await memberNames(ctx, householdId);
  const exchanges: string[] = [];
  let total = 0;
  for (const row of rows) {
    const reply = row.reply?.trim();
    if (!reply) continue;
    const exchange = `${authorLabel(names, row.requestedBy)}: ${clip(joinLines(row.message), MAX_TEXT_CHARS)}\nSunny: ${clip(joinLines(reply), MAX_TEXT_CHARS)}`;
    if (total + exchange.length > MAX_SECTION_CHARS) break;
    total += exchange.length;
    exchanges.push(exchange);
  }
  if (exchanges.length === 0) return "";
  return `${CARRY_OVER_HEADING}\n${exchanges.reverse().join("\n\n")}\n\n`;
}
