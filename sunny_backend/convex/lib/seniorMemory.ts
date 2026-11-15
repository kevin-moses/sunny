import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { audit } from "./audit";
import { appError } from "./errors";
import { MAX_FACT, MAX_UNVERIFIED_SENIOR_FACTS } from "./memoryLimits";
import { factCandidates, findFactDuplicate } from "./profileReads";
import { oneLine } from "./text";
import { VOICE_AGENT } from "./voiceRouting";

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
