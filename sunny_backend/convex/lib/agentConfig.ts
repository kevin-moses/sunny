// lib/agentConfig.ts
// Purpose: STUB (part A of the agent runtime owns the real file). Name, model and system
// prompt of the household agent, read by scripts/setup_managed_agent.ts. The lead replaces
// this file with part A's version at merge; only the exported names are relied upon.
//
// Last modified: 2026-10-29

/** Display name of the Managed Agents agent. */
export const AGENT_NAME = "sunny-household-agent";

/** Model the agent runs on. */
export const AGENT_MODEL = "claude-sonnet-5-5";

/** System prompt of the agent (stub). */
export const AGENT_SYSTEM_PROMPT =
  "You are Sunny, an assistant that helps a family caregiver manage a senior's calendar.";
