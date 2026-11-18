import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL, AGENT_SYSTEM_PROMPT } from "./agentConfig";
import { AGENT_TOOLS } from "./agentTools";
import { ConfigError } from "./errors";

const DEFAULT_BUDGET_CENTS = 100;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

export interface SessionEvent {
  id: string;
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  custom_tool_use_id?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: { type: string };
}

export interface ToolResult {
  toolUseId: string;
  text: string;
  isError: boolean;
}

export type SessionStatus = "rescheduling" | "running" | "idle" | "terminated";

export type TurnState =
  { state: "running" } | { state: "replied"; reply: string } | { state: "stopped"; reason: string };

export interface AgentConfig {
  apiKey: string;
  agentId: string;
  environmentId: string;
  budgetCents: number;
}

export function readAgentConfig(
  env: Record<string, string | undefined> = process.env,
): AgentConfig {
  const apiKey = env.ANTHROPIC_API_KEY;
  const agentId = env.SUNNY_AGENT_ID;
  const environmentId = env.SUNNY_ENVIRONMENT_ID;
  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["SUNNY_AGENT_ID", agentId],
    ["SUNNY_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (!apiKey || !agentId || !environmentId) {
    throw new Error(
      `The agent is not configured: set ${missing.join(", ")} on the Convex deployment`,
    );
  }
  const cents = Number(env.SUNNY_AGENT_SESSION_BUDGET_CENTS || DEFAULT_BUDGET_CENTS);
  const budgetCents = Number.isInteger(cents) && cents > 0 ? cents : DEFAULT_BUDGET_CENTS;
  return { apiKey, agentId, environmentId, budgetCents };
}

export function client(
  apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
  options: { timeout?: number; maxRetries?: number } = {},
): Anthropic {
  if (!apiKey) {
    throw new ConfigError(
      "The agent is not configured: set ANTHROPIC_API_KEY on the Convex deployment",
    );
  }
  return new Anthropic({
    apiKey,
    timeout: options.timeout ?? REQUEST_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
  });
}

function userMessage(text: string) {
  return { type: "user.message" as const, content: [{ type: "text" as const, text }] };
}

export async function createSession(
  config: AgentConfig,
  params: { title: string; requestId: string; householdId: string; text: string },
): Promise<string> {
  const session = await client(config.apiKey).beta.sessions.create({
    agent: {
      type: "agent_with_overrides",
      id: config.agentId,
      model: AGENT_MODEL,
      system: AGENT_SYSTEM_PROMPT,
      tools: AGENT_TOOLS,
    },
    environment_id: config.environmentId,
    title: params.title,
    metadata: { request_id: params.requestId, household_id: params.householdId },
    budget: {
      type: "limit",
      max_list_cost: { amount: String(config.budgetCents), currency: "USD" },
    },
    initial_events: [userMessage(params.text)],
  });
  return session.id;
}

export async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  await client().beta.sessions.events.send(sessionId, { events: [userMessage(text)] });
}

export async function sendToolResults(sessionId: string, results: ToolResult[]): Promise<void> {
  await client().beta.sessions.events.send(sessionId, {
    events: results.map((r) => ({
      type: "user.custom_tool_result" as const,
      custom_tool_use_id: r.toolUseId,
      content: [{ type: "text" as const, text: r.text }],
      is_error: r.isError,
    })),
  });
}

export async function getSessionStatus(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionStatus> {
  return (await client().beta.sessions.retrieve(sessionId, null, { signal })).status;
}

export async function listSessionEvents(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionEvent[]> {
  const all: SessionEvent[] = [];
  for await (const event of client().beta.sessions.events.list(sessionId, null, { signal })) {
    all.push(event as unknown as SessionEvent);
  }
  return all;
}

export function pendingToolUses(events: SessionEvent[]): SessionEvent[] {
  const answered = new Set(
    events.filter((e) => e.type === "user.custom_tool_result").map((e) => e.custom_tool_use_id),
  );
  return events.filter((e) => e.type === "agent.custom_tool_use" && !answered.has(e.id));
}

export function countUserMessages(events: SessionEvent[]): number {
  return events.filter((e) => e.type === "user.message").length;
}

export function finishedTurn(events: SessionEvent[], baseline = 0): TurnState {
  if (countUserMessages(events) <= baseline) return { state: "running" };
  const lastUser = events.findLastIndex((e) => e.type === "user.message");
  const after = events.slice(lastUser + 1);
  const idle = after.findLast((e) => e.type === "session.status_idle");
  const reason = idle?.stop_reason?.type;
  if (!idle || reason === "requires_action") return { state: "running" };
  if (reason !== "end_turn") return { state: "stopped", reason: reason ?? "unknown" };
  const reply = after
    .filter((e) => e.type === "agent.message")
    .flatMap((e) => (e.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? ""))
    .join("\n")
    .trim();
  return { state: "replied", reply: reply || "Done." };
}
