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
import { ConfigError } from "./errors";

/** Default per-session spend cap, in US cents. */
const DEFAULT_BUDGET_CENTS = 100;

/** Per-attempt timeout of an API request (the SDK default is 10 minutes). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Retries of 408/409/429/5xx and connection errors, done by the SDK itself (its default is 2). */
const MAX_RETRIES = 2;

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
  budgetCents: number;
}

/**
 * purpose: Read the agent configuration from the environment.
 * @param env: (Record<string, string | undefined>) Environment to read; defaults to process.env.
 * @return: (AgentConfig) The configuration.
 * @raises Error naming the unset variables when ANTHROPIC_API_KEY, SUNNY_AGENT_ID or
 *         SUNNY_ENVIRONMENT_ID is missing.
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

/**
 * purpose: An Anthropic client; the one place clients are built.
 * @param apiKey: (string, optional) Key to use; defaults to ANTHROPIC_API_KEY.
 * @param options: ({ timeout?, maxRetries? }, optional) Per-attempt timeout in ms and SDK
 *        retries; default to the agent runtime's.
 * @return: (Anthropic) The client.
 * @raises ConfigError when no key is available.
 */
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
  const session = await client(config.apiKey).beta.sessions.create({
    agent: config.agentId,
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
 * @param signal: (AbortSignal, optional) Aborts the request (and its retries).
 * @return: (Promise<SessionStatus>) The status.
 */
export async function getSessionStatus(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionStatus> {
  return (await client().beta.sessions.retrieve(sessionId, null, { signal })).status;
}

/**
 * purpose: List every event of a session in server order.
 * @param sessionId: (string) Session id.
 * @param signal: (AbortSignal, optional) Aborts the request (and its retries).
 * @return: (Promise<SessionEvent[]>) All events.
 */
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
 * purpose: How many user.message events a session has.
 * @param events: (SessionEvent[]) Session events in server order.
 * @return: (number) The count; used as the baseline before posting a new message.
 */
export function countUserMessages(events: SessionEvent[]): number {
  return events.filter((e) => e.type === "user.message").length;
}

/**
 * purpose: Decide whether the turn started by the latest user message has finished.
 * @param events: (SessionEvent[]) Session events in server order.
 * @param baseline: (number) How many user.message events existed before this request's
 *        message was posted (0 for a new session). A turn only counts once more than
 *        `baseline` user messages are visible, because the event list can lag and would
 *        otherwise show the previous turn's reply.
 * @return: (TurnState) "replied" with the agent's text when the session idled at end of
 *         turn after the latest user message; "stopped" for any other idle stop (budget
 *         reached, refusal, retries exhausted); "running" while it is still working, is
 *         waiting on tool results, or the new message is not visible yet.
 */
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
