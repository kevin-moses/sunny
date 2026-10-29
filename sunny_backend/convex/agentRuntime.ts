// agentRuntime.ts
// Purpose: Runs a caregiver's request to the household agent as a Convex Workflow over a
// Managed Agents session (agentRequests.ts starts it). Contracts that are not obvious:
// - Every acting step re-checks the request and households.backgroundPaused (readGate): paused
//   makes the workflow sleep a minute and retry, and a request no longer queued or running
//   (cancelled) ends the run. A request over 30 minutes old fails, and that cap includes time
//   spent paused (the error then says the request timed out while paused).
// - One session is driven by one request at a time (agentRequests.request enforces it). A
//   continuation records baselineUserMessages before posting, and finishedTurn ignores any turn
//   that does not include a newer user message, so a lagging event list cannot return a stale reply.
// - A tool call runs once: its agentToolCalls row is inserted in the same transaction as its
//   effect, a repeat reuses the row, and sent results are marked so a lagging event list is ignored.
// - `error` on a request is caregiver-safe text; raw detail goes to `errorDetail` and the log.
// - onRunComplete fails or cancels the row if the workflow dies while the row is in progress.
// - Steps: markRunning, startSession (records the session), then per poll one pollSession, and for
//   tool calls also executeToolCalls and sendToolResults (marks sent), then finishRequest. A reply
//   with no tools is 4 steps; each tool round adds 3; each pause check adds a sleep plus a re-run.
// - The workflow body must stay stable while runs are in flight (notes/CONVEX_MIGRATION.md).
//
// Last modified: 2026-10-29

import { vResultValidator, WorkflowManager, type WorkflowCtx } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { buildBriefing } from "./lib/agentBriefing";
import { errorText, GENERIC_ERROR, isInProgress, transitionRequest } from "./lib/agentRequestState";
import { executeAgentTool } from "./lib/agentTools";
import {
  countUserMessages,
  createSession,
  finishedTurn,
  getSessionStatus,
  listSessionEvents,
  pendingToolUses,
  readAgentConfig,
  sendToolResults as sendToolResultsToSession,
  sendUserMessage,
  type ToolResult,
} from "./lib/managedAgents";
import { toolCall, type ToolCall } from "./lib/validators";

/** A request that has not finished after this long is given up rather than run forever. */
export const MAX_REQUEST_AGE_MS = 30 * 60_000;
/** How often a paused household is re-checked. */
export const PAUSE_RECHECK_MS = 60_000;
/** Error shown when a request outlives MAX_REQUEST_AGE_MS. */
export const TIMEOUT_ERROR = "The agent did not finish this request in time";
/** Error shown when a request outlives MAX_REQUEST_AGE_MS while the household was paused. */
export const PAUSED_TIMEOUT_ERROR =
  "This request timed out while Sunny's background work was paused. Resume it and ask again.";
/** How long one poll step watches the session before returning "still running". */
const POLL_WINDOW_MS = 4 * 60_000;
/** Hard stop for one poll step (aborts in-flight API calls); far below the 10 minute action limit. */
const POLL_HARD_LIMIT_MS = 6 * 60_000;
/** First delay between session reads inside a poll step; it doubles up to POLL_MAX_DELAY_MS. */
const POLL_START_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 5_000;
/**
 * Backstop on workflow loop rounds (each round is one poll, one start attempt or one pause
 * check). The 30 minute cap ends a run long before this many.
 */
const MAX_LOOP_ROUNDS = 200;
/** Most sent tool calls read back per poll; more than this fails the request. */
const MAX_SENT_LOOKUP = 500;

/** The workflow manager for this app (also used by agentRequests.ts to start and cancel runs). */
export const workflow = new WorkflowManager(components.workflow);

/** Whether a step may act: go ahead, wait (paused), or stop for good. */
export type Gate = "go" | "paused" | "expired" | "expiredWhilePaused" | "cancelled";

/** A step that failed the request: `error` is caregiver-safe, `detail` is internal. */
export type Failure = { kind: "failed"; error: string; detail?: string };

/** Why a step did not act. */
export type Stop = { kind: "paused" } | { kind: "cancelled" } | Failure;

/** What one poll step found. */
export type PollResult =
  | { kind: "running" }
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "replied"; reply: string }
  | Failure;

/** The gate for a request, with the request itself when the step may go ahead. */
type GateResult = { gate: "go"; request: Doc<"agentRequests"> } | { gate: Exclude<Gate, "go"> };

/** What startSession needs, or the reason it should not start. */
export type SessionInputs =
  | { stop: Stop }
  | {
      stop: null;
      householdId: Id<"households">;
      text: string;
      /** The session when this request's start already happened (the step is re-running). */
      sessionId: string | null;
      /** Session of the earlier request being continued. */
      continueSessionId: string | null;
    };

/**
 * purpose: A failure with the generic caregiver message and an internal detail.
 * @param detail: (string) Raw reason (logged and stored in errorDetail, never shown).
 * @param error: (string) Caregiver-safe text; defaults to GENERIC_ERROR.
 * @return: (Failure) The failure.
 */
function failure(detail: string, error: string = GENERIC_ERROR): Failure {
  return { kind: "failed", error, detail };
}

/**
 * purpose: Decide whether a request's steps may act now.
 * @param ctx: (QueryCtx) Context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param now: (number) Epoch ms.
 * @return: (Promise<GateResult>) "cancelled" when the request is gone or no longer queued or
 *         running, "expired" (or "expiredWhilePaused") past MAX_REQUEST_AGE_MS from creation,
 *         "paused" while the household's backgroundPaused is true, else "go" with the request.
 */
export async function readGate(
  ctx: QueryCtx,
  requestId: Id<"agentRequests">,
  now: number,
): Promise<GateResult> {
  const request = await ctx.db.get(requestId);
  if (!request || !isInProgress(request.status)) return { gate: "cancelled" };
  const household = await ctx.db.get(request.householdId);
  if (!household) return { gate: "cancelled" };
  if (now - request._creationTime > MAX_REQUEST_AGE_MS) {
    return { gate: household.backgroundPaused ? "expiredWhilePaused" : "expired" };
  }
  return household.backgroundPaused ? { gate: "paused" } : { gate: "go", request };
}

/**
 * purpose: The stop a step reports for a gate that blocks acting.
 * @param gate: (Exclude<Gate, "go">) The blocking gate.
 * @return: (Stop) failed with the matching timeout error for the expired gates, else the
 *         gate's own kind.
 */
export function stopFor(gate: Exclude<Gate, "go">): Stop {
  if (gate === "expired") return { kind: "failed", error: TIMEOUT_ERROR };
  if (gate === "expiredWhilePaused") return { kind: "failed", error: PAUSED_TIMEOUT_ERROR };
  return { kind: gate };
}

/**
 * purpose: Check the gate from an action step.
 * @param ctx: (ActionCtx) Action context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: (Promise<Stop | null>) The stop to report, or null when the step may go ahead.
 */
async function gateOrStop(ctx: ActionCtx, requestId: Id<"agentRequests">): Promise<Stop | null> {
  const gate: Gate = await ctx.runQuery(internal.agentRuntime.gate, { requestId });
  return gate === "go" ? null : stopFor(gate);
}

/**
 * purpose: Look up the stored row for one tool call of a request.
 * @param ctx: (QueryCtx) Context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param toolUseId: (string) Managed Agents tool use id.
 * @return: (Promise<Doc<"agentToolCalls"> | null>) The row, or null.
 */
async function findToolCall(
  ctx: QueryCtx,
  requestId: Id<"agentRequests">,
  toolUseId: string,
): Promise<Doc<"agentToolCalls"> | null> {
  return await ctx.db
    .query("agentToolCalls")
    .withIndex("by_request_tool", (q) => q.eq("requestId", requestId).eq("toolUseId", toolUseId))
    .unique();
}

/**
 * purpose: The request's gate, for action steps (see readGate).
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: (Gate) go, paused, expired or cancelled.
 */
export const gate = internalQuery({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<Gate> => {
    return (await readGate(ctx, requestId, Date.now())).gate;
  },
});

/**
 * purpose: Mark a queued request running as the workflow starts.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: ({ kind: "ok" | "cancelled" }) "cancelled" when the request is no longer in
 *         progress (the workflow should end).
 */
export const markRunning = internalMutation({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<{ kind: "ok" | "cancelled" }> => {
    const moved = await transitionRequest(ctx, requestId, { status: "running" });
    return { kind: moved ? "ok" : "cancelled" };
  },
});

/**
 * purpose: Everything startSession needs: the gate, the briefing plus message, and the
 *          session to continue (set on the row up front for a continuation).
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: (SessionInputs) The inputs, or the stop to report (including failed when the
 *         earlier conversation has no session).
 */
export const sessionInputs = internalQuery({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<SessionInputs> => {
    const now = Date.now();
    const g = await readGate(ctx, requestId, now);
    if (g.gate !== "go") return { stop: stopFor(g.gate) };
    const { request } = g;
    let continueSessionId: string | null = null;
    if (request.continueRequestId) {
      const earlier = await ctx.db.get(request.continueRequestId);
      continueSessionId = request.sessionId ?? earlier?.sessionId ?? null;
      if (!continueSessionId) {
        return { stop: failure("The earlier conversation has no session to continue") };
      }
    }
    // A continuation has started once its baseline is recorded (just before posting); a new
    // session has started once its id is recorded.
    const started = continueSessionId
      ? request.baselineUserMessages !== undefined
      : request.sessionId !== undefined;
    const briefing = await buildBriefing(ctx, request.householdId, request.requestedBy, now);
    return {
      stop: null,
      householdId: request.householdId,
      text: `${briefing}\n\nCaregiver's request:\n${request.message}`,
      sessionId: started ? (continueSessionId ?? request.sessionId ?? null) : null,
      continueSessionId,
    };
  },
});

/**
 * purpose: Save the Managed Agents session id on the request right after it is started, so a
 *          continuation can find it. Bookkeeping, so not pause-gated.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param sessionId: (string) Session id.
 */
export const recordSession = internalMutation({
  args: { requestId: v.id("agentRequests"), sessionId: v.string() },
  handler: async (ctx, { requestId, sessionId }): Promise<null> => {
    if (await ctx.db.get(requestId)) await ctx.db.patch(requestId, { sessionId });
    else
      console.warn(`recordSession: request ${requestId} no longer exists (session ${sessionId})`);
    return null;
  },
});

/**
 * purpose: Save how many user messages a session had before this request's message is posted,
 *          so the poll can tell the new turn from the previous one. Written before posting, so a
 *          re-run never recomputes it after the message is in the session.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param baseline: (number) user.message events in the session so far.
 */
export const recordBaseline = internalMutation({
  args: { requestId: v.id("agentRequests"), baseline: v.number() },
  handler: async (ctx, { requestId, baseline }): Promise<null> => {
    if (await ctx.db.get(requestId))
      await ctx.db.patch(requestId, { baselineUserMessages: baseline });
    else console.warn(`recordBaseline: request ${requestId} no longer exists`);
    return null;
  },
});

/**
 * purpose: Start the session (or post to the continued one) with the briefing and message,
 *          recording the session id (or, for a continuation, the baseline) right away.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: ({ kind: "started", sessionId } | Stop) The session id, or why nothing was started
 *         (paused, cancelled, or failed with the generic message and a detail such as missing
 *         configuration).
 */
export const startSession = internalAction({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<{ kind: "started"; sessionId: string } | Stop> => {
    const inputs: SessionInputs = await ctx.runQuery(internal.agentRuntime.sessionInputs, {
      requestId,
    });
    if (inputs.stop) return inputs.stop;
    if (inputs.sessionId) return { kind: "started", sessionId: inputs.sessionId };
    let sessionId: string;
    try {
      const config = readAgentConfig();
      if (inputs.continueSessionId) {
        const baseline = countUserMessages(await listSessionEvents(inputs.continueSessionId));
        await ctx.runMutation(internal.agentRuntime.recordBaseline, { requestId, baseline });
        await sendUserMessage(inputs.continueSessionId, inputs.text);
        return { kind: "started", sessionId: inputs.continueSessionId };
      }
      sessionId = await createSession(config, {
        title: `Household ${inputs.householdId.slice(0, 8)}: caregiver request`,
        requestId,
        householdId: inputs.householdId,
        text: inputs.text,
      });
    } catch (e) {
      return failure(errorText(e));
    }
    await ctx.runMutation(internal.agentRuntime.recordSession, { requestId, sessionId });
    return { kind: "started", sessionId };
  },
});

/**
 * purpose: Sleep for a number of milliseconds.
 * @param ms: (number) Delay.
 * @return: (Promise<void>) Resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * purpose: Watch a session until it needs something from us or the window ends. Reads back
 *          off from POLL_START_DELAY_MS, doubling up to POLL_MAX_DELAY_MS, and no read starts
 *          once the window is spent.
 * @param sessionId: (string) Session id.
 * @param state: ({ sent, baseline }) Tool calls whose results were already sent (ignored even
 *        if the lagging event list still shows them pending) and the user-message baseline
 *        (see finishedTurn).
 * @param windowMs: (number) How long to keep polling.
 * @param signal: (AbortSignal, optional) Aborts in-flight API calls.
 * @return: (Promise<PollResult>) tools (unanswered calls), replied, failed (terminated or
 *         stopped without finishing) or running (window ended, session still working).
 */
export async function pollUntil(
  sessionId: string,
  state: { sent: ReadonlySet<string>; baseline: number },
  windowMs: number,
  signal?: AbortSignal,
): Promise<PollResult> {
  const deadline = Date.now() + windowMs;
  let delay = POLL_START_DELAY_MS;
  for (;;) {
    const status = await getSessionStatus(sessionId, signal);
    if (status === "terminated") return failure(`Agent session ${sessionId} terminated`);
    if (status === "idle") {
      const events = await listSessionEvents(sessionId, signal);
      const pending = pendingToolUses(events).filter((e) => !state.sent.has(e.id));
      if (pending.length) {
        const calls = pending.map((e) => ({
          toolUseId: e.id,
          name: e.name ?? "",
          input: JSON.stringify(e.input ?? {}),
        }));
        return { kind: "tools", calls };
      }
      const turn = finishedTurn(events, state.baseline);
      if (turn.state === "stopped") {
        return failure(`The agent stopped without finishing (${turn.reason})`);
      }
      if (turn.state === "replied") return { kind: "replied", reply: turn.reply };
    }
    if (Date.now() + delay >= deadline) return { kind: "running" };
    await sleep(delay);
    delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
  }
}

/**
 * purpose: What a poll needs from the database: the tool calls already sent and the
 *          request's user-message baseline.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: ({ sent: string[]; baseline: number }) Sent tool use ids and the baseline (0 for a
 *         new session).
 * @raises Error when more than MAX_SENT_LOOKUP calls were sent (the request fails rather than
 *         risk answering a call twice).
 */
export const pollInputs = internalQuery({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<{ sent: string[]; baseline: number }> => {
    const request = await ctx.db.get(requestId);
    const rows = await ctx.db
      .query("agentToolCalls")
      .withIndex("by_request_sent", (q) => q.eq("requestId", requestId).gt("sentAt", 0))
      .take(MAX_SENT_LOOKUP + 1);
    if (rows.length > MAX_SENT_LOOKUP) {
      throw new Error(`More than ${MAX_SENT_LOOKUP} tool calls sent for request ${requestId}`);
    }
    return { sent: rows.map((r) => r.toolUseId), baseline: request?.baselineUserMessages ?? 0 };
  },
});

/**
 * purpose: One poll step: check the gate, then watch the session for up to POLL_WINDOW_MS.
 *          In-flight API calls are aborted at POLL_HARD_LIMIT_MS (the step then reports
 *          "running"). Other API errors throw so the workflow retries the step.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param sessionId: (string) Session id.
 * @return: (PollResult | Stop) What the session needs, or why the step did not act.
 */
export const pollSession = internalAction({
  args: { requestId: v.id("agentRequests"), sessionId: v.string() },
  handler: async (ctx, { requestId, sessionId }): Promise<PollResult | Stop> => {
    const stop = await gateOrStop(ctx, requestId);
    if (stop) return stop;
    const inputs: { sent: string[]; baseline: number } = await ctx.runQuery(
      internal.agentRuntime.pollInputs,
      { requestId },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_HARD_LIMIT_MS);
    try {
      const state = { sent: new Set(inputs.sent), baseline: inputs.baseline };
      return await pollUntil(sessionId, state, POLL_WINDOW_MS, controller.signal);
    } catch (e) {
      if (controller.signal.aborted) return { kind: "running" };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },
});

/**
 * purpose: Run each pending tool call exactly once. If an agentToolCalls row exists for the
 *          call its stored result is kept; otherwise the tool runs and the row is inserted
 *          in this same transaction, so a retried step never repeats an effect.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param calls: (ToolCall[]) Calls to run.
 * @return: ({ kind: "ok" } | Stop) Stop when paused, cancelled or expired.
 */
export const executeToolCalls = internalMutation({
  args: { requestId: v.id("agentRequests"), calls: v.array(toolCall) },
  handler: async (ctx, { requestId, calls }): Promise<{ kind: "ok" } | Stop> => {
    const now = Date.now();
    const g = await readGate(ctx, requestId, now);
    if (g.gate !== "go") return stopFor(g.gate);
    for (const call of calls) {
      await runToolOnce(ctx, g.request.householdId, requestId, call, now);
    }
    return { kind: "ok" };
  },
});

/**
 * purpose: Run one tool call unless its result is already recorded.
 * @param ctx: (MutationCtx) Mutation context; the tool's writes share this transaction.
 * @param householdId: (Id<"households">) Household taken from the request row, never the model.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param call: (ToolCall) The call.
 * @param now: (number) Epoch ms.
 */
async function runToolOnce(
  ctx: MutationCtx,
  householdId: Id<"households">,
  requestId: Id<"agentRequests">,
  call: ToolCall,
  now: number,
): Promise<void> {
  if (await findToolCall(ctx, requestId, call.toolUseId)) return;
  const input = JSON.parse(call.input) as Record<string, unknown>;
  const result = await executeAgentTool(ctx, householdId, call.name, input, now);
  await ctx.db.insert("agentToolCalls", { requestId, ...call, ...result });
}

/**
 * purpose: Read the stored results for tool calls, in the order asked.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param toolUseIds: (string[]) Tool use ids.
 * @return: (ToolResult[]) Stored results; an id with no row is omitted.
 */
export const storedResults = internalQuery({
  args: { requestId: v.id("agentRequests"), toolUseIds: v.array(v.string()) },
  handler: async (ctx, { requestId, toolUseIds }): Promise<ToolResult[]> => {
    const rows = await Promise.all(toolUseIds.map((id) => findToolCall(ctx, requestId, id)));
    return rows.flatMap((row) =>
      row ? [{ toolUseId: row.toolUseId, text: row.text, isError: row.isError }] : [],
    );
  },
});

/**
 * purpose: Mark tool results as sent so later polls ignore the calls even if the session's
 *          event list lags. Idempotent: a call already marked keeps its first sentAt.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param toolUseIds: (string[]) Calls whose results were sent.
 */
export const markToolsSent = internalMutation({
  args: { requestId: v.id("agentRequests"), toolUseIds: v.array(v.string()) },
  handler: async (ctx, { requestId, toolUseIds }): Promise<null> => {
    const now = Date.now();
    const rows = await Promise.all(toolUseIds.map((id) => findToolCall(ctx, requestId, id)));
    await Promise.all(
      rows.flatMap((row) =>
        row && row.sentAt === undefined ? [ctx.db.patch(row._id, { sentAt: now })] : [],
      ),
    );
    return null;
  },
});

/**
 * purpose: Send the stored results of the given tool calls to the session in one request,
 *          then mark them sent.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param sessionId: (string) Session id.
 * @param toolUseIds: (string[]) Calls to answer.
 * @return: ({ kind: "sent" } | Stop) Stop when paused or cancelled, or failed with the generic
 *         message and the API error as detail.
 */
export const sendToolResults = internalAction({
  args: {
    requestId: v.id("agentRequests"),
    sessionId: v.string(),
    toolUseIds: v.array(v.string()),
  },
  handler: async (ctx, { requestId, sessionId, toolUseIds }): Promise<{ kind: "sent" } | Stop> => {
    const stop = await gateOrStop(ctx, requestId);
    if (stop) return stop;
    const results: ToolResult[] = await ctx.runQuery(internal.agentRuntime.storedResults, {
      requestId,
      toolUseIds,
    });
    if (results.length !== toolUseIds.length) {
      return failure("A tool result was missing when it was time to send it");
    }
    try {
      await sendToolResultsToSession(sessionId, results);
    } catch (e) {
      return failure(errorText(e));
    }
    await ctx.runMutation(internal.agentRuntime.markToolsSent, { requestId, toolUseIds });
    return { kind: "sent" };
  },
});

/**
 * purpose: Write the outcome of a request. Does nothing unless it is still queued or running
 *          (a caregiver cancel wins over a late result).
 * @param requestId: (Id<"agentRequests">) The request.
 * @param status: ("succeeded" | "failed") Outcome.
 * @param reply: (string, optional) The agent's reply when succeeded.
 * @param error: (string, optional) Caregiver-safe reason when failed.
 * @param detail: (string, optional) Internal reason when failed (logged, stored in errorDetail).
 */
export const finishRequest = internalMutation({
  args: {
    requestId: v.id("agentRequests"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    reply: v.optional(v.string()),
    error: v.optional(v.string()),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, status, reply, error, detail }): Promise<null> => {
    await transitionRequest(
      ctx,
      requestId,
      status === "succeeded"
        ? { status, reply: reply ?? "Done." }
        : { status, error: error ?? GENERIC_ERROR, detail },
    );
    return null;
  },
});

/**
 * purpose: Workflow completion handler: if the workflow errored or was cancelled while the
 *          request is still queued or running, mark the request failed or cancelled.
 * @param workflowId: (string) The workflow that ended.
 * @param result: (RunResult) success, failed (with error) or canceled.
 * @param context: ({ requestId }) The request the workflow ran for.
 */
export const onRunComplete = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: v.object({ requestId: v.id("agentRequests") }),
  },
  handler: async (ctx, { result, context }): Promise<null> => {
    await transitionRequest(
      ctx,
      context.requestId,
      result.kind === "canceled"
        ? { status: "cancelled" }
        : {
            status: "failed",
            error: GENERIC_ERROR,
            detail:
              result.kind === "failed"
                ? `The workflow failed: ${result.error}`
                : "The workflow ended without a result",
          },
    );
    return null;
  },
});

/** What a workflow round decides: keep looping (null), a reply, or a stop. */
type Next = null | { kind: "replied"; reply: string } | Stop;

/**
 * purpose: Workflow phase 1: start (or continue) the session.
 * @param step: (WorkflowCtx) Workflow context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: ({ sessionId } | Stop) The session id, or why it did not start.
 */
async function startPhase(
  step: WorkflowCtx,
  requestId: Id<"agentRequests">,
): Promise<{ sessionId: string } | Stop> {
  const begun = await step.runAction(internal.agentRuntime.startSession, { requestId });
  return begun.kind === "started" ? { sessionId: begun.sessionId } : begun;
}

/**
 * purpose: Workflow phase 2: run the tool calls the agent asked for and send the results.
 * @param step: (WorkflowCtx) Workflow context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param sessionId: (string) Session id.
 * @param calls: (ToolCall[]) The pending calls.
 * @return: (Promise<Stop | null>) A stop, or null when the results were sent.
 */
async function toolRound(
  step: WorkflowCtx,
  requestId: Id<"agentRequests">,
  sessionId: string,
  calls: ToolCall[],
): Promise<Stop | null> {
  const ran = await step.runMutation(internal.agentRuntime.executeToolCalls, { requestId, calls });
  if (ran.kind !== "ok") return ran;
  const toolUseIds = calls.map((c) => c.toolUseId);
  const sent = await step.runAction(internal.agentRuntime.sendToolResults, {
    requestId,
    sessionId,
    toolUseIds,
  });
  return sent.kind === "sent" ? null : sent;
}

/**
 * purpose: Workflow round: poll the session and act on what it needs.
 * @param step: (WorkflowCtx) Workflow context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param sessionId: (string) Session id.
 * @return: (Promise<Next>) null to loop again, the reply, or a stop.
 */
async function pollRound(
  step: WorkflowCtx,
  requestId: Id<"agentRequests">,
  sessionId: string,
): Promise<Next> {
  const polled = await step.runAction(
    internal.agentRuntime.pollSession,
    { requestId, sessionId },
    { retry: true },
  );
  if (polled.kind === "running") return null;
  if (polled.kind === "tools") return await toolRound(step, requestId, sessionId, polled.calls);
  return polled;
}

/**
 * purpose: The workflow for one request. See the file header for the step layout.
 * @param requestId: (Id<"agentRequests">) The request to run.
 */
export const run = workflow.define({
  args: { requestId: v.id("agentRequests") },
  handler: async (step, { requestId }): Promise<null> => {
    const started = await step.runMutation(internal.agentRuntime.markRunning, { requestId });
    if (started.kind === "cancelled") return null;

    /**
     * purpose: Write the request's outcome and end the run.
     * @param outcome: (object) succeeded with the reply, or failed with caregiver-safe text
     *        and an optional internal detail.
     * @return: (Promise<null>) Always null (the workflow's return value).
     */
    const finish = async (
      outcome:
        | { status: "succeeded"; reply: string }
        | { status: "failed"; error: string; detail?: string },
    ): Promise<null> => {
      await step.runMutation(internal.agentRuntime.finishRequest, { requestId, ...outcome });
      return null;
    };

    let sessionId: string | null = null;
    for (let round = 0; round < MAX_LOOP_ROUNDS; round++) {
      let next: Next;
      if (sessionId === null) {
        const begun = await startPhase(step, requestId);
        if ("sessionId" in begun) {
          sessionId = begun.sessionId;
          continue;
        }
        next = begun;
      } else {
        next = await pollRound(step, requestId, sessionId);
      }
      if (next === null) continue;
      if (next.kind === "replied") return await finish({ status: "succeeded", reply: next.reply });
      if (next.kind === "failed") {
        return await finish({ status: "failed", error: next.error, detail: next.detail });
      }
      if (next.kind === "cancelled") return null;
      await step.sleep(PAUSE_RECHECK_MS);
    }
    return await finish({
      status: "failed",
      error: GENERIC_ERROR,
      detail: "The workflow took too many rounds",
    });
  },
});
