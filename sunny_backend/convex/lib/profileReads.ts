import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  DUPLICATE_SCAN,
  MAX_VERIFIED_FACTS,
  MEMORY_CONTEXT_LIMIT,
  VERIFIED_READ_LIMIT,
} from "./memoryLimits";
import { textKey } from "./text";
import { LIFE_CATEGORIES } from "./validators";

export function compareEntries(
  a: Pick<Doc<"lifeProfileEntries">, "category" | "name">,
  b: Pick<Doc<"lifeProfileEntries">, "category" | "name">,
): number {
  return (
    LIFE_CATEGORIES.indexOf(a.category) - LIFE_CATEGORIES.indexOf(b.category) ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
}

export async function entriesInOrder(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"lifeProfileEntries">[]> {
  const rows = await ctx.db
    .query("lifeProfileEntries")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
  return rows.sort(compareEntries);
}

export async function verifiedFacts(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"agentMemory">[]> {
  return await ctx.db
    .query("agentMemory")
    .withIndex("by_household_verified", (q) => q.eq("householdId", householdId).gt("verifiedAt", 0))
    .order("desc")
    .take(VERIFIED_READ_LIMIT);
}

export async function newestUnverified(
  ctx: QueryCtx,
  householdId: Id<"households">,
  limit: number,
): Promise<Doc<"agentMemory">[]> {
  return await ctx.db
    .query("agentMemory")
    .withIndex("by_household_verified", (q) =>
      q.eq("householdId", householdId).eq("verifiedAt", undefined),
    )
    .order("desc")
    .take(limit);
}

export async function factCandidates(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<{ verified: Doc<"agentMemory">[]; candidates: Doc<"agentMemory">[] }> {
  const [verified, unverified] = await Promise.all([
    verifiedFacts(ctx, householdId),
    newestUnverified(ctx, householdId, DUPLICATE_SCAN),
  ]);
  return { verified, candidates: [...verified, ...unverified] };
}

export function findFactDuplicate(
  candidates: Doc<"agentMemory">[],
  fact: string,
  exceptId: Id<"agentMemory"> | null,
): Doc<"agentMemory"> | null {
  const key = textKey(fact);
  return candidates.find((r) => r._id !== exceptId && textKey(r.fact) === key) ?? null;
}

export function factsInAgentOrder(
  verified: Doc<"agentMemory">[],
  unverified: Doc<"agentMemory">[],
): Doc<"agentMemory">[] {
  return [...[...verified].sort((a, b) => b._creationTime - a._creationTime), ...unverified];
}

export async function agentMemoryWindow(
  ctx: QueryCtx,
  householdId: Id<"households">,
): Promise<Doc<"agentMemory">[]> {
  const verified = factsInAgentOrder(await verifiedFacts(ctx, householdId), []).slice(
    0,
    MAX_VERIFIED_FACTS,
  );
  const unverified = await newestUnverified(
    ctx,
    householdId,
    MEMORY_CONTEXT_LIMIT - verified.length,
  );
  return [...verified, ...unverified];
}
