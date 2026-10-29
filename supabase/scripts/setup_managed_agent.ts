// setup_managed_agent.ts
// Purpose: Creates (or updates) the household agent and its environment in Claude
// Managed Agents. Run once per Anthropic workspace, then store the printed ids as Edge
// Function secrets (SUNNY_AGENT_ID, SUNNY_ENVIRONMENT_ID). Re-run with SUNNY_AGENT_ID set
// to publish a new agent version after changing the prompt or tools; running sessions
// keep the version they started with. The agent gets only Sunny's custom tools (no
// shell, files or web), and its environment allows no outbound network.
//
// Usage (from the repo root, with ANTHROPIC_API_KEY in the env file):
//   deno run -A --env-file=sunny_agent/.env supabase/scripts/setup_managed_agent.ts
//
// Last modified: 2026-10-27

import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";
import { AGENT_MODEL, AGENT_NAME, AGENT_SYSTEM_PROMPT } from "../functions/_shared/agent_config.ts";
import { AGENT_TOOLS } from "../functions/_shared/agent_tools.ts";

/**
 * purpose: Create the environment unless SUNNY_ENVIRONMENT_ID is set; create or update
 *          the agent; print the ids to store as secrets.
 */
async function main(): Promise<void> {
  const client = new Anthropic();

  let environmentId = Deno.env.get("SUNNY_ENVIRONMENT_ID");
  if (!environmentId) {
    const environment = await client.beta.environments.create({
      name: "sunny-household-agent",
      config: {
        type: "cloud",
        networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: false },
      },
    });
    environmentId = environment.id;
  }

  const config = {
    name: AGENT_NAME,
    model: AGENT_MODEL,
    system: AGENT_SYSTEM_PROMPT,
    tools: AGENT_TOOLS as Anthropic.Beta.Agents.AgentCreateParams["tools"],
    metadata: { app: "sunny" },
  };
  const existingId = Deno.env.get("SUNNY_AGENT_ID");
  const agent = existingId
    ? await client.beta.agents.update(existingId, config)
    : await client.beta.agents.create(config);

  console.log(`SUNNY_ENVIRONMENT_ID=${environmentId}`);
  console.log(`SUNNY_AGENT_ID=${agent.id}`);
  console.log(`# agent version ${agent.version}`);
}

await main();
