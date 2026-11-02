// lib/agentFingerprint.ts
// Purpose: A short fingerprint of the household agent's configuration (model, system prompt and
// tools from agentConfig.ts and agentTools.ts). agentRequests stores it on each request so a
// conversation started under an older config is not continued after a deploy changes the
// prompt, model or tools: Managed Agents sessions keep the config they started with. It is
// change detection only (32-bit FNV-1a), not security.
//
// Last modified: 2026-11-01

import { AGENT_MODEL, AGENT_SYSTEM_PROMPT } from "./agentConfig";
import { AGENT_TOOLS } from "./agentTools";

/**
 * purpose: Hash a string with 32-bit FNV-1a.
 * @param text: (string) Input.
 * @return: (string) The hash as 8 lowercase hex digits.
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * purpose: Fingerprint an agent configuration.
 * @param model: (string) Model id.
 * @param system: (string) System prompt.
 * @param tools: (unknown) Tool definitions (JSON-serializable).
 * @return: (string) The fingerprint.
 */
export function fingerprintAgentConfig(model: string, system: string, tools: unknown): string {
  return fnv1a(JSON.stringify([model, system, tools]));
}

/** Fingerprint of the agent config in the deployed code. */
export const AGENT_CONFIG_FINGERPRINT: string = fingerprintAgentConfig(
  AGENT_MODEL,
  AGENT_SYSTEM_PROMPT,
  AGENT_TOOLS,
);
