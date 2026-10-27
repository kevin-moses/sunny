// jobs-run/agent.ts
// Purpose: The agent runtime behind agent_chat jobs. AgentRuntime is the interface the
// job runner depends on; ManagedAgentsRuntime is the POC implementation on Claude
// Managed Agents (a self-hosted Claude API worker can implement the same interface).
// A run starts (or continues) a Managed Agents session with a household briefing built
// from Postgres plus the caregiver's message, answers the agent's custom tool calls
// through our RPCs, and finishes when the session idles at end of turn. Resuming needs
// only the job checkpoint: the session id, plus the result of every tool call already
// run, saved before it is sent, so a retry re-sends a stored result instead of running a
// tool (adding an event) twice. Pending tool calls and the reply are rebuilt from the
// session's event list. Any other stop (budget, refusal, retries exhausted) fails the job.
// See notes/AGENT_RUNTIME.md.
//
// Last modified: 2026-10-27

import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { rpc } from "../_shared/admin.ts";
import { executeTool } from "../_shared/agent_tools.ts";
import { type Job, type JobOutcome, PermanentJobError } from "./types.ts";

const POLL_MS = 1000;
const RESUME_DELAY_MS = 5000;
// A request that has not finished after this long is given up rather than resumed forever.
const MAX_JOB_AGE_MS = 30 * 60_000;

/** Runs agent jobs; implementations decide where the model loop and tools run. */
export interface AgentRuntime {
  /**
   * purpose: Make progress on an agent job until it finishes or the deadline nears.
   * @param job: (Job) The claimed job.
   * @param deadline: (number) Epoch ms by which run must return.
   * @return: (Promise<JobOutcome>) done with { reply, session_id }, or defer to resume.
   */
  run(job: Job, deadline: number): Promise<JobOutcome>;
}

/** A tool call's result as sent to the agent (and saved in the job checkpoint). */
interface ToolResult {
  text: string;
  isError: boolean;
}

/** The fields of session events this runtime reads. */
interface SessionEvent {
  id: string;
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  custom_tool_use_id?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: { type: string };
}

/**
 * purpose: Wait for a number of milliseconds.
 * @param ms: (number) Delay.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Managed Agents implementation of AgentRuntime. */
export class ManagedAgentsRuntime implements AgentRuntime {
  private anthropic: Anthropic;
  private db: SupabaseClient;
  private agentId: string;
  private environmentId: string;
  private budgetCents: string;

  /**
   * purpose: Configure the runtime.
   * @param db: (SupabaseClient) Service-role client.
   * @param anthropic: (Anthropic | undefined) API client; defaults to ANTHROPIC_API_KEY.
   */
  constructor(db: SupabaseClient, anthropic?: Anthropic) {
    const agentId = Deno.env.get("SUNNY_AGENT_ID");
    const environmentId = Deno.env.get("SUNNY_ENVIRONMENT_ID");
    if (!agentId || !environmentId) {
      throw new PermanentJobError("SUNNY_AGENT_ID and SUNNY_ENVIRONMENT_ID must be set");
    }
    this.db = db;
    this.anthropic = anthropic ?? new Anthropic();
    this.agentId = agentId;
    this.environmentId = environmentId;
    const cents = Number(Deno.env.get("SUNNY_AGENT_SESSION_BUDGET_CENTS") || "100");
    this.budgetCents = String(Number.isInteger(cents) && cents > 0 ? cents : 100);
  }

  /**
   * purpose: Start or resume the job's session and drive it to the end of the turn.
   * @param job: (Job) Claimed agent_chat job; payload.message, optional
   *             payload.continue_job_id (an earlier agent_chat job whose session to
   *             continue); checkpoint.session_id once started.
   * @param deadline: (number) Epoch ms by which to return.
   * @return: (Promise<JobOutcome>) done with { reply, session_id }, or defer.
   */
  async run(job: Job, deadline: number): Promise<JobOutcome> {
    if (Date.now() - Date.parse(job.created_at) > MAX_JOB_AGE_MS) {
      throw new PermanentJobError("The agent did not finish this request in time");
    }
    let sessionId = job.checkpoint.session_id as string | undefined;
    if (!sessionId) {
      sessionId = await this.start(job);
      // Save at once so a crash before the end resumes this session instead of a new one.
      await rpc(this.db, "checkpoint_job", { p_job_id: job.id, p_checkpoint: { session_id: sessionId } });
    }

    // Results of tool calls already run (saved in the checkpoint), and the calls answered in
    // this run, in case the event list lags behind what we sent.
    const toolResults: Record<string, ToolResult> = { ...(job.checkpoint.tool_results as Record<string, ToolResult>) };
    const answered = new Set<string>();
    while (Date.now() < deadline - POLL_MS) {
      const session = await this.anthropic.beta.sessions.retrieve(sessionId);
      if (session.status === "terminated") {
        throw new PermanentJobError(`Agent session ${sessionId} terminated`);
      }
      if (session.status === "idle") {
        const events = await this.events(sessionId);
        const pending = pendingToolUses(events).filter((e) => !answered.has(e.id));
        if (pending.length) {
          await this.answerTools(job, sessionId, pending, toolResults);
          pending.forEach((e) => answered.add(e.id));
          continue;
        }
        const turn = finishedTurn(events);
        if (turn.state === "stopped") {
          throw new PermanentJobError(`The agent stopped without finishing (${turn.reason})`);
        }
        if (turn.state === "replied") {
          return { type: "done", result: { reply: turn.reply, session_id: sessionId } };
        }
      }
      await sleep(POLL_MS);
    }
    return {
      type: "defer",
      checkpoint: { session_id: sessionId },
      resumeAt: new Date(Date.now() + RESUME_DELAY_MS),
      waiting: false,
    };
  }

  /**
   * purpose: Create the session (or post to the session being continued) with the
   *          household briefing and the caregiver's message.
   * @param job: (Job) The agent_chat job.
   * @return: (Promise<string>) Session id.
   */
  private async start(job: Job): Promise<string> {
    const message = typeof job.payload.message === "string" ? job.payload.message : "";
    if (!message) throw new PermanentJobError("agent_chat job has no message");
    const text = `${await this.briefing(job)}\n\nCaregiver's request:\n${message}`;
    const userMessage = { type: "user.message" as const, content: [{ type: "text" as const, text }] };

    const continueJobId = job.payload.continue_job_id;
    if (typeof continueJobId === "string") {
      const { data: earlier } = await this.db.from("jobs").select("checkpoint")
        .eq("id", continueJobId).eq("household_id", job.household_id).maybeSingle();
      const continueId = earlier?.checkpoint?.session_id;
      if (typeof continueId !== "string") {
        throw new PermanentJobError("The earlier conversation has not started yet");
      }
      await this.anthropic.beta.sessions.events.send(continueId, { events: [userMessage] });
      return continueId;
    }
    const session = await this.anthropic.beta.sessions.create({
      agent: this.agentId,
      environment_id: this.environmentId,
      title: `Household ${job.household_id.slice(0, 8)}: caregiver request`,
      metadata: { job_id: job.id, household_id: job.household_id },
      budget: { type: "limit", max_list_cost: { amount: this.budgetCents, currency: "USD" } },
      initial_events: [userMessage],
    });
    return session.id;
  }

  /**
   * purpose: Build the household briefing from Postgres: who the senior is, the
   *          timezone, the local date and time, who is asking, and the coming week.
   * @param job: (Job) The agent_chat job (household and requesting caregiver).
   * @return: (Promise<string>) Briefing text.
   */
  private async briefing(job: Job): Promise<string> {
    const [day, { data: member }] = await Promise.all([
      rpc<Record<string, any>>(this.db, "get_day_view", { p_household_id: job.household_id }),
      this.db.from("household_members").select("display_name")
        .eq("household_id", job.household_id).eq("user_id", job.requested_by ?? "").maybeSingle(),
    ]);

    const events = [...(day.events_today ?? []), ...(day.upcoming ?? [])]
      .map((e: Record<string, unknown>) =>
        `- ${e.local_date} ${String(e.start_time).slice(0, 5)} ${e.title} (event_id ${e.event_id})`
      );
    return [
      "Household briefing (from Sunny's records):",
      `- Senior: ${day.senior_preferred_name}`,
      `- Timezone: ${day.timezone}`,
      `- Now: ${day.weekday}, ${day.local_now} local`,
      `- Requested by: ${member?.display_name ?? "a caregiver"}`,
      "- Calendar, today and the next 7 days:",
      ...(events.length ? events : ["  (nothing scheduled)"]),
    ].join("\n");
  }

  /**
   * purpose: List every event of a session in server order.
   * @param sessionId: (string) Session id.
   * @return: (Promise<SessionEvent[]>) All events.
   */
  private async events(sessionId: string): Promise<SessionEvent[]> {
    const all: SessionEvent[] = [];
    for await (const event of this.anthropic.beta.sessions.events.list(sessionId)) {
      all.push(event as unknown as SessionEvent);
    }
    return all;
  }

  /**
   * purpose: Answer pending custom tool calls. Each call runs at most once per job: its
   *          result is saved to the job checkpoint before anything is sent, and a call
   *          already in the checkpoint (a retry after a crash or a failed send) re-uses the
   *          saved result. All results go to the session in one request.
   * @param job: (Job) The job (household and id).
   * @param sessionId: (string) Session id.
   * @param uses: (SessionEvent[]) agent.custom_tool_use events without results.
   * @param toolResults: (Record<string, ToolResult>) Saved results by tool use id; updated.
   */
  private async answerTools(
    job: Job,
    sessionId: string,
    uses: SessionEvent[],
    toolResults: Record<string, ToolResult>,
  ): Promise<void> {
    for (const use of uses) {
      if (toolResults[use.id]) continue;
      toolResults[use.id] = await executeTool(this.db, job.household_id, use.name ?? "", use.input ?? {});
      await rpc(this.db, "checkpoint_job", { p_job_id: job.id, p_checkpoint: { tool_results: toolResults } });
    }
    await this.anthropic.beta.sessions.events.send(sessionId, {
      events: uses.map((use) => ({
        type: "user.custom_tool_result" as const,
        custom_tool_use_id: use.id,
        content: [{ type: "text" as const, text: toolResults[use.id].text }],
        is_error: toolResults[use.id].isError,
      })),
    });
  }
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

/** Where the turn started by the latest user message stands. */
export type TurnState =
  | { state: "running" }
  | { state: "replied"; reply: string }
  | { state: "stopped"; reason: string };

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
