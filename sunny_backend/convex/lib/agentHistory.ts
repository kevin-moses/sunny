// lib/agentHistory.ts
// Purpose: The "Earlier in this conversation" section of a new agent session's first message.
// When a deploy changes the agent config, the household's next message starts a new Managed
// Agents session (agentRequests.findLatestContinuable); this replays the recent chat into it so
// the caregiver sees one continuing conversation. Bounded: the last MAX_EXCHANGES succeeded
// requests (an indexed, limited read), each message and reply cut to MAX_TEXT_CHARS, and the
// whole section to MAX_SECTION_CHARS (oldest exchanges dropped first).
//
// Last modified: 2026-11-01

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Most earlier exchanges replayed into a new session. */
export const MAX_EXCHANGES = 10;
/** Longest caregiver message or reply replayed, in characters. */
export const MAX_TEXT_CHARS = 500;
/** Longest section (excluding its heading), in characters. */
export const MAX_SECTION_CHARS = 6000;

/** Heading of the section; the agent prompt refers to it. */
export const CARRY_OVER_HEADING = "Earlier in this conversation (most recent last):";

/**
 * purpose: Cut text to a length, marking the cut.
 * @param text: (string) Text.
 * @param max: (number) Longest result length.
 * @return: (string) The text, or its start followed by "..." when cut.
 */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3)}...`;
}

/**
 * purpose: Build the earlier-conversation section for a household.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<string>) The section followed by a blank line, or "" when no succeeded
 *          exchange with a reply exists.
 */
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
  const exchanges: string[] = [];
  let total = 0;
  for (const row of rows) {
    const reply = row.reply?.trim();
    if (!reply) continue;
    const exchange = `Caregiver: ${clip(row.message, MAX_TEXT_CHARS)}\nSunny: ${clip(reply, MAX_TEXT_CHARS)}`;
    if (total + exchange.length > MAX_SECTION_CHARS) break;
    total += exchange.length;
    exchanges.push(exchange);
  }
  if (exchanges.length === 0) return "";
  return `${CARRY_OVER_HEADING}\n${exchanges.reverse().join("\n\n")}\n\n`;
}
