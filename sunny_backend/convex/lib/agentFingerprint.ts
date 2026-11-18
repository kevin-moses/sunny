import { AGENT_MODEL, AGENT_SYSTEM_PROMPT } from "./agentConfig";
import { AGENT_TOOLS } from "./agentTools";

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function fingerprintAgentConfig(model: string, system: string, tools: unknown): string {
  return fnv1a(JSON.stringify([model, system, tools]));
}

export const AGENT_CONFIG_FINGERPRINT: string = fingerprintAgentConfig(
  AGENT_MODEL,
  AGENT_SYSTEM_PROMPT,
  AGENT_TOOLS,
);
