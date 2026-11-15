import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL, AGENT_NAME, AGENT_SYSTEM_PROMPT } from "../convex/lib/agentConfig";
import { AGENT_TOOLS } from "../convex/lib/agentTools";

const BACKEND_DIR = fileURLToPath(new URL("..", import.meta.url));

function convexEnv(args: string[], prod: boolean): string {
  const out = execFileSync("npx", ["convex", "env", ...args, ...(prod ? ["--prod"] : [])], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    cwd: BACKEND_DIR,
  });
  return out.trim();
}

function resolveId(name: string, prod: boolean): string | undefined {
  return convexEnv(["get", name], prod) || undefined;
}

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
