// lib/agentTools.ts
// Purpose: STUB (part A of the agent runtime owns the real file). The custom tools the
// household agent may call and the function that runs one of them inside the caller's
// transaction. The lead replaces this file with part A's version at merge; only the
// exported names and signatures are relied upon by agentRuntime.ts.
//
// Last modified: 2026-10-29

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Managed Agents custom tool definitions (stub: none). */
export const AGENT_TOOLS: Array<Record<string, unknown>> = [];

/**
 * purpose: Run one agent tool call for a household inside the caller's transaction (stub).
 * @param _ctx: (MutationCtx) Mutation context of the caller.
 * @param _householdId: (Id<"households">) Household the call acts on; never taken from the model.
 * @param name: (string) Tool name.
 * @param _input: (Record<string, unknown>) Tool input from the model.
 * @param _now: (number) Epoch ms to use as the current time.
 * @return: (Promise<{ text: string; isError: boolean }>) Result text sent back to the agent.
 */
export async function executeAgentTool(
  _ctx: MutationCtx,
  _householdId: Id<"households">,
  name: string,
  _input: Record<string, unknown>,
  _now: number,
): Promise<{ text: string; isError: boolean }> {
  return { text: `Unknown tool: ${name}`, isError: true };
}
