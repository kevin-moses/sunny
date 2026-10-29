// lib/managedAgents.ts
// Purpose: Thin wrapper over the Anthropic SDK's Managed Agents API (beta.sessions) for the
// agent runtime (agentRuntime.ts), plus the two pure functions that read a session's event
// list: pendingToolUses (custom tool calls still waiting for a result) and finishedTurn
// (whether the turn started by the latest user message has ended, and how). Ported from
// supabase/functions/jobs-run/agent.ts with the logic unchanged. Everything that touches the
// network lives in the wrapper functions so tests can replace this module wholesale and never
// call the real API. Env: ANTHROPIC_API_KEY, SUNNY_AGENT_ID, SUNNY_ENVIRONMENT_ID, and
// optionally SUNNY_AGENT_SESSION_BUDGET_CENTS (default 100). See notes/AGENT_RUNTIME.md.
//
// Last modified: 2026-10-29

import Anthropic from "@anthropic-ai/sdk";

/** Default per-session spend cap, in US cents. */
export const DEFAULT_BUDGET_CENTS = 100;

/** The fields of session events this runtime reads. */
export interface SessionEvent {
  id: string;
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  custom_tool_use_id?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: { type: string };
}

/** A tool call's result as sent to the agent. */
export interface ToolResult {
  toolUseId: string;
  text: string;
  isError: boolean;
}

/** Status of a Managed Agents session as reported by the API. */
export type SessionStatus = "rescheduling" | "running" | "idle" | "terminated";

/** Where the turn started by the latest user message stands. */
export type TurnState =
  { state: "running" } | { state: "replied"; reply: string } | { state: "stopped"; reason: string };

/** Everything needed to create sessions, read from the environment. */
export interface AgentConfig {
  apiKey: string;
  agentId: string;
  environmentId: string;
  budgetCents: string;
}

/** Thrown when required environment variables are not set; the message names them. */
export class MissingConfigError extends Error {
  /**
   * purpose: Build the error.
   * @param missing: (string[]) Names of the unset variables.
   */
  constructor(missing: string[]) {
    super(`The agent is not configured: set ${missing.join(", ")} on the Convex deployment`);
    this.name = "MissingConfigError";
  }
}

/**
 * purpose: Read the agent configuration from the environment.
 * @param env: (Record<string, string | undefined>) Environment to read; defaults to process.env.
 * @return: (AgentConfig) The configuration.
 * @raises MissingConfigError when ANTHROPIC_API_KEY, SUNNY_AGENT_ID or SUNNY_ENVIRONMENT_ID is unset.
 */
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
    .map(([name]) => name as string);
  if (!apiKey || !agentId || !environmentId) throw new MissingConfigError(missing);
  const cents = Number(env.SUNNY_AGENT_SESSION_BUDGET_CENTS || DEFAULT_BUDGET_CENTS);
  const budget = Number.isInteger(cents) && cents > 0 ? cents : DEFAULT_BUDGET_CENTS;
  return { apiKey, agentId, environmentId, budgetCents: String(budget) };
}

/**
 * purpose: An Anthropic client for the configured API key.
 * @return: (Anthropic) The client.
 * @raises MissingConfigError when ANTHROPIC_API_KEY is unset.
 */
function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MissingConfigError(["ANTHROPIC_API_KEY"]);
  return new Anthropic({ apiKey });
}

/**
 * purpose: A user.message event carrying plain text.
 * @param text: (string) Message text.
 * @return: A user.message event for the sessions API.
 */
function userMessage(text: string) {
  return { type: "user.message" as const, content: [{ type: "text" as const, text }] };
}

/**
 * purpose: Create a session with the first user message and a spend cap.
 * @param config: (AgentConfig) Agent, environment and budget.
 * @param params: ({ title, requestId, householdId, text }) Session title, ids stored as
 *        metadata, and the first user message.
 * @return: (Promise<string>) The session id.
 */
export async function createSession(
  config: AgentConfig,
  params: { title: string; requestId: string; householdId: string; text: string },
): Promise<string> {
  const session = await new Anthropic({ apiKey: config.apiKey }).beta.sessions.create({
    agent: config.agentId,
    environment_id: config.environmentId,
    title: params.title,
    metadata: { request_id: params.requestId, household_id: params.householdId },
    budget: { type: "limit", max_list_cost: { amount: config.budgetCents, currency: "USD" } },
    initial_events: [userMessage(params.text)],
  });
  return session.id;
}

/**
 * purpose: Post a user message to an existing session (a continued conversation).
 * @param sessionId: (string) Session id.
 * @param text: (string) Message text.
 */
export async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  await client().beta.sessions.events.send(sessionId, { events: [userMessage(text)] });
}

/**
 * purpose: Post tool results to a session, all in one request.
 * @param sessionId: (string) Session id.
 * @param results: (ToolResult[]) One result per answered agent.custom_tool_use.
 */
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

/**
 * purpose: Read a session's status.
 * @param sessionId: (string) Session id.
 * @return: (Promise<SessionStatus>) The status.
 */
export async function getSessionStatus(sessionId: string): Promise<SessionStatus> {
  return (await client().beta.sessions.retrieve(sessionId)).status;
}

/**
 * purpose: List every event of a session in server order.
 * @param sessionId: (string) Session id.
 * @return: (Promise<SessionEvent[]>) All events.
 */
export async function listSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const all: SessionEvent[] = [];
  for await (const event of client().beta.sessions.events.list(sessionId)) {
    all.push(event as unknown as SessionEvent);
  }
  return all;
}

/**
 * purpose: Custom tool calls the agent is still waiting on.
 * @param events: (SessionEvent[]) Session events in server order.
 * @return: (SessionEvent[]) agent.custom_tool_use events with no user.custom_tool_result.
 */
export function pendingToolUses(events: SessionEvent[]): SessionEvent[] {
  const answered = new Set(
    events.filter((e) => e.type === "user.custom_tool_result").map((e) => e.custom_tool_use_id),
  );
  return events.filter((e) => e.type === "agent.custom_tool_use" && !answered.has(e.id));
}

/**
 * purpose: Decide whether the turn started by the latest user message has finished.
 * @param events: (SessionEvent[]) Session events in server order.
 * @return: (TurnState) "replied" with the agent's text when the session idled at end of
 *         turn after the latest user message; "stopped" for any other idle stop (budget
 *         reached, refusal, retries exhausted); "running" while it is still working or
 *         waiting on tool results.
 */
export function finishedTurn(events: SessionEvent[]): TurnState {
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
