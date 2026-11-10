// lib/memoryLimits.ts
// Purpose: The one place the agentMemory limits live, shared by the voice agent's
// rememberFact and getContext (agent.ts) and available to the caregiver-side memory writes.
// Also the normalization both sides use to compare fact text.
//
// - MAX_FACT_LENGTH: longest fact stored (single line, trimmed).
// - MEMORY_CONTEXT_LIMIT: facts given to the voice agent per conversation; verified facts take
//   up to MEMORY_CONTEXT_LIMIT - MEMORY_UNVERIFIED_RESERVE slots, so at least
//   MEMORY_UNVERIFIED_RESERVE slots always go to the newest unverified facts.
// - MAX_VERIFIED_FACTS: the caregiver side's cap on verified facts per household.
// - MAX_UNVERIFIED_SENIOR_FACTS: unverified facts the senior stated that are kept per
//   household; rememberFact deletes the oldest beyond it.
// - MEMORY_SCAN_LIMIT: rows read (newest first) when checking for a duplicate, trimming or
//   building the context, so no call reads an unbounded number of rows.
//
// Last modified: 2026-11-09

/** Longest fact stored, after collapsing whitespace. */
export const MAX_FACT_LENGTH = 300;
/** Facts in the voice agent's context. */
export const MEMORY_CONTEXT_LIMIT = 50;
/** Context slots always kept for unverified facts. */
export const MEMORY_UNVERIFIED_RESERVE = 10;
/** Verified facts a household may have (enforced by the caregiver side). */
export const MAX_VERIFIED_FACTS = 40;
/** Unverified senior-stated facts kept per household; older ones are trimmed on insert. */
export const MAX_UNVERIFIED_SENIOR_FACTS = 200;
/** Rows read per call; above every cap combined. */
export const MEMORY_SCAN_LIMIT = MAX_VERIFIED_FACTS + MAX_UNVERIFIED_SENIOR_FACTS + 60;

/**
 * purpose: A fact as one trimmed line: every run of whitespace (newlines included) becomes a
 *          single space.
 * @param text: (string) Raw fact.
 * @return: (string) The single-line text, not yet capped.
 */
export function singleLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * purpose: The key two facts are compared by: single line, lower case.
 * @param text: (string) A fact.
 * @return: (string) The comparison key.
 */
export function factKey(text: string): string {
  return singleLine(text).toLowerCase();
}
