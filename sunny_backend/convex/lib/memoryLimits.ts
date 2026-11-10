// lib/memoryLimits.ts
// Purpose: The one place the agentMemory limits live, used by the caregiver write path
// (profile.ts), the voice agent (agent.ts rememberFact and getContext) and the shared reads
// (lib/profileReads.ts).
//
// - MAX_FACT: longest fact stored (one line).
// - MEMORY_CONTEXT_LIMIT: facts given to the voice agent per conversation; verified facts take
//   at most MEMORY_CONTEXT_LIMIT - MEMORY_UNVERIFIED_RESERVE places, so at least
//   MEMORY_UNVERIFIED_RESERVE places always go to the newest unverified facts.
// - MAX_VERIFIED_FACTS: verified facts a household may have (profile.ts refuses more); equal
//   to MEMORY_CONTEXT_LIMIT - MEMORY_UNVERIFIED_RESERVE.
// - MAX_UNVERIFIED_SENIOR_FACTS: unverified facts the senior stated that are kept per
//   household; rememberFact deletes the oldest beyond it.
// - VERIFIED_READ_LIMIT: most verified facts any read loads (above the cap, for rows written
//   before it).
// - DUPLICATE_SCAN: newest unverified facts a duplicate check looks at.
//
// Last modified: 2026-11-09

/** Longest fact stored, after flattening to one line. */
export const MAX_FACT = 300;
/** Facts in the voice agent's context. */
export const MEMORY_CONTEXT_LIMIT = 50;
/** Context places always kept for unverified facts. */
export const MEMORY_UNVERIFIED_RESERVE = 10;
/** Verified facts a household may have: the rest of the context window. */
export const MAX_VERIFIED_FACTS = MEMORY_CONTEXT_LIMIT - MEMORY_UNVERIFIED_RESERVE;
/** Unverified senior-stated facts kept per household; older ones are trimmed on insert. */
export const MAX_UNVERIFIED_SENIOR_FACTS = 200;
/** Most verified facts any read loads. */
export const VERIFIED_READ_LIMIT = 200;
/** Newest unverified facts a duplicate check looks at. */
export const DUPLICATE_SCAN = 500;
