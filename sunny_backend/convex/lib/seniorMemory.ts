// lib/seniorMemory.ts
// Purpose: What the senior asks the voice agent to remember ("Remember that...", "I put my
// glasses in the hall drawer"), for agent.rememberFact. A fact is a new agentMemory row with
// source senior, unverified, linked to the conversation; only a caregiver verifies it
// (profile.ts). Rules:
// - The fact is one line (lib/text.oneLine) cut to MAX_FACT characters; blank is invalid.
// - A fact whose text key (lib/text.textKey) matches a stored one, found with the same
//   duplicate check profile.addFact uses (lib/profileReads), stores nothing: already_known.
// - No existing row is ever edited or verified. The only rows removed are the household's
//   oldest unverified senior-stated facts beyond MAX_UNVERIFIED_SENIOR_FACTS, each audited as
//   "trim", so conversation cannot grow the table without limit.
//
// Last modified: 2026-11-09

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { audit } from "./audit";
import { appError } from "./errors";
import { MAX_FACT, MAX_UNVERIFIED_SENIOR_FACTS } from "./memoryLimits";
import { factCandidates, findFactDuplicate } from "./profileReads";
import { oneLine } from "./text";
import { VOICE_AGENT } from "./voiceRouting";

/**
 * purpose: Remember something the senior said (see the header for the rules).
 * @param ctx: (MutationCtx) Context.
 * @param args: ({householdId, fact, conversationId}) The household, the fact as said and the
 *        conversation it came from.
 * @return: (Promise<{status}>) saved, or already_known (both success).
 * @raises invalid for a blank fact.
 */
export async function rememberFactCore(
  ctx: MutationCtx,
  args: { householdId: Id<"households">; fact: string; conversationId?: Id<"conversations"> },
): Promise<{ status: "saved" | "already_known" }> {
  const { householdId, conversationId } = args;
  const fact = oneLine(args.fact).slice(0, MAX_FACT).trim();
  if (fact === "") throw appError("invalid", "The fact cannot be blank");
  const { candidates } = await factCandidates(ctx, householdId);
  if (findFactDuplicate(candidates, fact, null)) return { status: "already_known" };
  const memoryId = await ctx.db.insert("agentMemory", {
    householdId,
    fact,
    source: "senior",
    conversationId,
  });
  // The new row is the newest unverified senior fact; keep MAX - 1 of the older ones.
  const olderSenior = candidates.filter((r) => r.source === "senior" && r.verifiedAt === undefined);
  for (const row of olderSenior.slice(MAX_UNVERIFIED_SENIOR_FACTS - 1)) {
    await ctx.db.delete(row._id);
    await audit(ctx, {
      householdId,
      actor: VOICE_AGENT,
      action: "trim",
      entity: "agentMemory",
      entityId: row._id,
      detail: { fact: row.fact, reason: "unverified senior facts over the cap" },
    });
  }
  await audit(ctx, {
    householdId,
    actor: VOICE_AGENT,
    action: "remember",
    entity: "agentMemory",
    entityId: memoryId,
    detail: { conversationId: conversationId ?? null },
  });
  return { status: "saved" };
}
