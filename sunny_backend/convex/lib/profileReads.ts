// lib/profileReads.ts
// Purpose: How what the agent knows is read and ordered, shared by the caregiver path
// (profile.ts listEntries, listMemory, addFact, correctFact) and the voice agent (agent.ts
// getContext, rememberFact), so "ordered as the agent sees it" holds by construction:
// - life profile entries (entriesInOrder): by category (declaration order: person, place,
//   doctor, habit, interest, preference, other), then by name, locale-aware and
//   case-insensitive;
// - memory: read through the agentMemory.by_household_verified index (never a scan): verified
//   facts, then the newest unverified ones; ordered verified first (newest noted first), then
//   unverified newest first; the agent's window is the newest MAX_VERIFIED_FACTS verified facts
//   plus the newest unverified facts up to MEMORY_CONTEXT_LIMIT;
// - duplicates: a fact matches another with the same lib/text.textKey among the verified facts
//   and the newest DUPLICATE_SCAN unverified ones (factCandidates, findFactDuplicate).
//
// Last modified: 2026-11-09

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

/**
 * purpose: Order life profile entries as the agent and the caregiver app show them.
 * @param a: (Pick<Doc<"lifeProfileEntries">, "category" | "name">) An entry.
 * @param b: (Pick<Doc<"lifeProfileEntries">, "category" | "name">) Another entry.
 * @return: (number) Negative when a comes first.
 */
export function compareEntries(
  a: Pick<Doc<"lifeProfileEntries">, "category" | "name">,
  b: Pick<Doc<"lifeProfileEntries">, "category" | "name">,
): number {
  return (
    LIFE_CATEGORIES.indexOf(a.category) - LIFE_CATEGORIES.indexOf(b.category) ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
}

/**
 * purpose: Every life profile entry of a household, in compareEntries order.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"lifeProfileEntries">[]>) The entries (capped by profile.addEntry).
 */
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

/**
 * purpose: The household's verified facts, newest verification first, through the
 *          by_household_verified index.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"agentMemory">[]>) At most VERIFIED_READ_LIMIT rows.
 */
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

/**
 * purpose: The household's newest unverified facts, through the by_household_verified index.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @param limit: (number) How many at most.
 * @return: (Promise<Doc<"agentMemory">[]>) The rows, newest first.
 */
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

/**
 * purpose: What a new fact's duplicate check looks at, read in parallel: the verified facts
 *          (verifiedFacts) and, as candidates, those plus the newest DUPLICATE_SCAN unverified
 *          ones.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<{verified, candidates}>) The verified facts and the candidates.
 */
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

/**
 * purpose: The fact among the candidates with the same text key, if any.
 * @param candidates: (Doc<"agentMemory">[]) Facts to look at (factCandidates).
 * @param fact: (string) The new fact's text.
 * @param exceptId: (Id<"agentMemory"> | null) A fact to ignore (the one being corrected).
 * @return: (Doc<"agentMemory"> | null) The duplicate, or null.
 */
export function findFactDuplicate(
  candidates: Doc<"agentMemory">[],
  fact: string,
  exceptId: Id<"agentMemory"> | null,
): Doc<"agentMemory"> | null {
  const key = textKey(fact);
  return candidates.find((r) => r._id !== exceptId && textKey(r.fact) === key) ?? null;
}

/**
 * purpose: Facts in the order the agent reads them: verified first (newest noted first),
 *          then unverified as given (newest first).
 * @param verified: (Doc<"agentMemory">[]) Verified facts, any order.
 * @param unverified: (Doc<"agentMemory">[]) Unverified facts, newest first.
 * @return: (Doc<"agentMemory">[]) The ordered facts.
 */
export function factsInAgentOrder(
  verified: Doc<"agentMemory">[],
  unverified: Doc<"agentMemory">[],
): Doc<"agentMemory">[] {
  return [...[...verified].sort((a, b) => b._creationTime - a._creationTime), ...unverified];
}

/**
 * purpose: The facts in the voice agent's context: the newest MAX_VERIFIED_FACTS verified facts
 *          and the newest unverified facts up to MEMORY_CONTEXT_LIMIT (at least
 *          MEMORY_UNVERIFIED_RESERVE of them), in factsInAgentOrder.
 * @param ctx: (QueryCtx) Context.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"agentMemory">[]>) At most MEMORY_CONTEXT_LIMIT facts.
 */
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
