// scripts/setup_managed_agent.ts
// Purpose: Creates (or updates) the household agent and its environment in Claude Managed
// Agents. Run once per Anthropic workspace, then store the printed ids as Convex environment
// variables (SUNNY_AGENT_ID, SUNNY_ENVIRONMENT_ID; the commands are printed). Re-run with
// SUNNY_AGENT_ID set to publish a new agent version after changing the prompt or tools in
// convex/lib/agentConfig.ts and convex/lib/agentTools.ts; running sessions keep the version
// they started with. The agent gets only Sunny's custom tools (no shell, files or web), and
// its environment allows no outbound network. Port of supabase/scripts/setup_managed_agent.ts.
// Not part of the deployed backend.
//
// Usage (from sunny_backend/, with ANTHROPIC_API_KEY in the env file):
//   npx tsx --env-file=.env.local scripts/setup_managed_agent.ts
// Update an existing agent (reuse its environment too):
//   SUNNY_AGENT_ID=agent_... SUNNY_ENVIRONMENT_ID=env_... \
//     npx tsx --env-file=.env.local scripts/setup_managed_agent.ts
//
// Last modified: 2026-10-29

import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL, AGENT_NAME, AGENT_SYSTEM_PROMPT } from "../convex/lib/agentConfig";
import { AGENT_TOOLS } from "../convex/lib/agentTools";

/**
 * purpose: Create the environment unless SUNNY_ENVIRONMENT_ID is set; create or update the
 *          agent; print the ids and the commands that store them on the Convex deployment.
 * @return: (Promise<void>) Resolves when done.
 */
async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Set ANTHROPIC_API_KEY (for example in .env.local, passed with --env-file)");
  }
  const client = new Anthropic();

  let environmentId = process.env.SUNNY_ENVIRONMENT_ID;
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
    tools: AGENT_TOOLS as unknown as Anthropic.Beta.Agents.AgentCreateParams["tools"],
    metadata: { app: "sunny" },
  };
  const existingId = process.env.SUNNY_AGENT_ID;
  const agent = existingId
    ? await client.beta.agents.update(existingId, config)
    : await client.beta.agents.create(config);

  console.log(`SUNNY_ENVIRONMENT_ID=${environmentId}`);
  console.log(`SUNNY_AGENT_ID=${agent.id}`);
  console.log(`# agent version ${agent.version}`);
  console.log("\nStore them on the Convex deployment (add --prod for production):");
  console.log(`  npx convex env set SUNNY_ENVIRONMENT_ID ${environmentId}`);
  console.log(`  npx convex env set SUNNY_AGENT_ID ${agent.id}`);
  console.log("  npx convex env set ANTHROPIC_API_KEY <your key>");
}

await main();
