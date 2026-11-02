// scripts/setup_managed_agent.ts
// Purpose: Creates (or updates) the household agent and its environment in Claude Managed
// Agents. The agent and environment ids live on the Convex deployment (SUNNY_AGENT_ID,
// SUNNY_ENVIRONMENT_ID) and are read from there, so one command both creates and updates:
// when an id is not set the script creates the resource and stores the new id on the
// deployment itself. Re-run after changing the prompt or tools in convex/lib/agentConfig.ts
// and convex/lib/agentTools.ts; running sessions keep the version they started with. The
// agent gets only Sunny's custom tools (no shell, files or web), and its environment allows no
// outbound network. Port of the former Supabase setup script. Not part of the deployed backend.
//
// Usage (from sunny_backend/; ANTHROPIC_API_KEY is read from the repo-root .env):
//   npm run setup:agent              # dev deployment
//   npm run setup:agent -- --prod    # production deployment
// The ids are read only from the Convex deployment (never from the process env), so --prod can
// not update a dev agent. .env.local is loaded after the root .env and wins if both define a key.
//
// Last modified: 2026-11-01

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL, AGENT_NAME, AGENT_SYSTEM_PROMPT } from "../convex/lib/agentConfig";
import { AGENT_TOOLS } from "../convex/lib/agentTools";

/** Directory of sunny_backend, so the convex CLI runs against the right project from any cwd. */
const BACKEND_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * purpose: Run `npx convex env <args>` against the dev or production deployment.
 * @param args: (string[]) Arguments after `convex env`, for example ["get", "NAME"].
 * @param prod: (boolean) Target the production deployment when true.
 * @return: (string) Trimmed stdout; empty when nothing was printed (for example an unset var).
 */
function convexEnv(args: string[], prod: boolean): string {
  const out = execFileSync("npx", ["convex", "env", ...args, ...(prod ? ["--prod"] : [])], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    cwd: BACKEND_DIR,
  });
  return out.trim();
}

/**
 * purpose: Read an id from the Convex deployment (never from the process env).
 * @param name: (string) Variable name, for example SUNNY_AGENT_ID.
 * @param prod: (boolean) Read from the production deployment when true.
 * @return: (string | undefined) The id, or undefined when it is not set on the deployment.
 */
function resolveId(name: string, prod: boolean): string | undefined {
  return convexEnv(["get", name], prod) || undefined;
}

/**
 * purpose: Print a freshly created id, then store it on the Convex deployment. The id is
 *          printed first so a failed store never loses a created resource.
 * @param name: (string) Variable name, for example SUNNY_AGENT_ID.
 * @param id: (string) The newly created resource id.
 * @param prod: (boolean) Store on the production deployment when true.
 * @return: (void) Rethrows if the store fails, after printing the manual command.
 */
function storeCreatedId(name: string, id: string, prod: boolean): void {
  console.log(`Created ${name}=${id}`);
  try {
    convexEnv(["set", name, id], prod);
  } catch (error) {
    console.error(
      `Could not store it; run: npx convex env set ${name} ${id}${prod ? " --prod" : ""}`,
    );
    throw error;
  }
}

/**
 * purpose: Create the environment if its id is unset; create or update the agent; store any
 *          newly created id on the Convex deployment; print a short summary.
 * @return: (Promise<void>) Resolves when done.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--prod")) {
    throw new Error("Usage: npm run setup:agent [-- --prod]");
  }
  const prod = args.length > 0;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Set ANTHROPIC_API_KEY (the npm script loads it from the repo-root .env, or export it)",
    );
  }
  const client = new Anthropic();

  let environmentId = resolveId("SUNNY_ENVIRONMENT_ID", prod);
  const environmentCreated = !environmentId;
  if (!environmentId) {
    const environment = await client.beta.environments.create({
      name: "sunny-household-agent",
      config: {
        type: "cloud",
        networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: false },
      },
    });
    environmentId = environment.id;
    storeCreatedId("SUNNY_ENVIRONMENT_ID", environmentId, prod);
  }

  const config = {
    name: AGENT_NAME,
    model: AGENT_MODEL,
    system: AGENT_SYSTEM_PROMPT,
    tools: AGENT_TOOLS,
    metadata: { app: "sunny" },
  };
  const existingId = resolveId("SUNNY_AGENT_ID", prod);
  const agentCreated = !existingId;
  const agent = existingId
    ? await client.beta.agents.update(existingId, config)
    : await client.beta.agents.create(config);
  if (agentCreated) storeCreatedId("SUNNY_AGENT_ID", agent.id, prod);

  console.log(`Deployment: ${prod ? "production" : "dev"}`);
  console.log(`Environment ${environmentId}: ${environmentCreated ? "created" : "reused"}`);
  console.log(
    `Agent ${agent.id}: ${agentCreated ? "created" : "updated"}, version ${agent.version}`,
  );
  console.log(
    "Running chat sessions keep the version they started with; start a new conversation to use the new tools.",
  );
  if (agentCreated) {
    console.log(
      "Also set ANTHROPIC_API_KEY on the Convex deployment: npx convex env set ANTHROPIC_API_KEY <key>",
    );
  }
}

await main();
