// agentRuntime.ts
// Purpose: Runs a caregiver's request to the household agent as a Convex Workflow, replacing
// the jobs-run ManagedAgentsRuntime. The workflow (`run`) marks the request running, starts
// (or continues) a Managed Agents session with the household briefing plus the caregiver's
// message, then loops: poll the session (one action step that polls for up to a few minutes),
// run each pending tool call (one mutation step, recorded once in agentToolCalls so a retried
// step or a poll that returns the same call twice never repeats a calendar write), send the
// results in one request, mark them sent. It ends by writing the reply (succeeded) or the
// reason (failed) to the agentRequests row the caregiver app subscribes to.
//
// Every step that acts re-checks the request and the household's backgroundPaused switch
// (readGate). A paused household makes the workflow sleep and re-check every minute; a
// request older than 30 minutes fails; a request no longer queued or running (cancelled)
// ends the workflow. The onComplete handler marks the request failed or cancelled if the
// workflow itself errors or is cancelled while the row is still in progress.
//
// Steps per request: markRunning, startSession, recordSession, then per round poll (and for
// tool calls executeToolCalls, sendToolResults, markToolsSent), finish. A single tool round
// is 9 steps; each extra tool round adds 4; each pause check adds 1 sleep plus the re-run
// step. The workflow body must stay stable while runs are in flight (see
// notes/CONVEX_MIGRATION.md, "Workflow versioning"). Env: see lib/managedAgents.ts.
//
// Last modified: 2026-10-29

import { vResultValidator, WorkflowManager } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { buildBriefing } from "./lib/agentBriefing";
import { executeAgentTool } from "./lib/agentTools";
import {
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

/** A request that has not finished after this long is given up rather than run forever. */
export const MAX_REQUEST_AGE_MS = 30 * 60_000;
/** How often a paused household is re-checked. */
export const PAUSE_RECHECK_MS = 60_000;
/** How long one poll step watches the session before returning "still running". */
export const POLL_WINDOW_MS = 4 * 60_000;
/** Delay between session reads inside one poll step. */
export const POLL_INTERVAL_MS = 1_000;
/** Safety net on workflow loop rounds; the 30 minute cap normally ends a run far earlier. */
const MAX_ROUNDS = 200;
/** Longest error text stored on a request. */
const MAX_ERROR_LENGTH = 500;
/** Error shown when a request outlives MAX_REQUEST_AGE_MS. */
export const TIMEOUT_ERROR = "The agent did not finish this request in time";

/** The workflow manager for this app (also used by agentRequests.ts to start and cancel runs). */
export const workflow = new WorkflowManager(components.workflow);

/** Whether a step may act: go ahead, wait (paused), or stop for good. */
export type Gate = "go" | "paused" | "expired" | "cancelled";

/** Why a step did not act. */
export type Stop = { kind: "paused" } | { kind: "cancelled" } | { kind: "failed"; error: string };

/** One tool call the agent is waiting on. */
export interface ToolCall {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

/** What one poll step found. */
export type PollResult =
  | { kind: "running" }
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "replied"; reply: string }
  | { kind: "failed"; error: string };

/** What a request's steps need to know, read in one query. */
export interface RunContext {
  gate: Gate;
  householdId: Id<"households">;
  message: string;
  sessionId: string | null;
  /** True when the request continues an earlier request's session. */
  continues: boolean;
  continueSessionId: string | null;
  sentToolUseIds: string[];
  briefing: string | null;
}

const toolCallValidator = v.object({
  toolUseId: v.string(),
  name: v.string(),
  input: v.record(v.string(), v.any()),
});

/**
 * purpose: Decide whether a request's steps may act now.
 * @param ctx: (QueryCtx) Context.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param now: (number) Epoch ms.
 * @return: (Promise<Gate>) "cancelled" when the request is gone or no longer queued/running,
 *         "expired" past MAX_REQUEST_AGE_MS from creation, "paused" while the household's
 *         backgroundPaused is true, else "go".
 */
export async function readGate(
  ctx: QueryCtx,
  requestId: Id<"agentRequests">,
  now: number,
): Promise<Gate> {
  const request = await ctx.db.get(requestId);
  if (!request || (request.status !== "queued" && request.status !== "running")) {
    return "cancelled";
  }
  if (now - request._creationTime > MAX_REQUEST_AGE_MS) return "expired";
  const household = await ctx.db.get(request.householdId);
  if (!household) return "cancelled";
  return household.backgroundPaused ? "paused" : "go";
}

/**
 * purpose: Translate a gate that blocks acting into the stop a step reports.
 * @param gate: (Gate) The gate.
 * @return: (Stop | null) The stop, or null when the step may go ahead.
 */
export function stopForGate(gate: Gate): Stop | null {
  if (gate === "go") return null;
  if (gate === "expired") return { kind: "failed", error: TIMEOUT_ERROR };
  return { kind: gate };
}

/**
 * purpose: Shorten an error for storing on a request.
 * @param text: (string) Error text.
 * @return: (string) At most MAX_ERROR_LENGTH characters.
 */
function clip(text: string): string {
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
}

/**
 * purpose: Read a request's gate, ids and (optionally) briefing for an action step.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param withBriefing: (boolean) Also build the household briefing (session start only).
 * @return: (RunContext | null) Null when the request no longer exists.
 */
export const loadContext = internalQuery({
  args: { requestId: v.id("agentRequests"), withBriefing: v.boolean() },
  handler: async (ctx, { requestId, withBriefing }): Promise<RunContext | null> => {
    const request = await ctx.db.get(requestId);
    if (!request) return null;
    const now = Date.now();
    const gate = await readGate(ctx, requestId, now);
    let continueSessionId: string | null = null;
    if (request.continueRequestId) {
      const earlier = await ctx.db.get(request.continueRequestId);
      continueSessionId = earlier?.sessionId ?? null;
    }
    const calls = await ctx.db
      .query("agentToolCalls")
      .withIndex("by_request_tool", (q) => q.eq("requestId", requestId))
      .collect();
    return {
      gate,
      householdId: request.householdId,
      message: request.message,
      sessionId: request.sessionId ?? null,
      continues: request.continueRequestId !== undefined,
      continueSessionId,
      sentToolUseIds: calls.filter((c) => c.sentAt !== undefined).map((c) => c.toolUseId),
      briefing:
        withBriefing && gate === "go"
          ? await buildBriefing(ctx, request.householdId, request.requestedBy, now)
          : null,
    };
  },
});

/**
 * purpose: Mark a queued request running as the workflow starts.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: ({ kind: "ok" | "cancelled" }) "cancelled" when the request is no longer queued
 *         or running (the workflow should end).
 */
export const markRunning = internalMutation({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<{ kind: "ok" | "cancelled" }> => {
    const request = await ctx.db.get(requestId);
    if (!request || (request.status !== "queued" && request.status !== "running")) {
      return { kind: "cancelled" };
    }
    if (request.status === "queued") await ctx.db.patch(requestId, { status: "running" });
    return { kind: "ok" };
  },
});

/**
 * purpose: Save the Managed Agents session id on the request right after it is started, so
 *          a later step or a continuation can find it. Bookkeeping, so not pause-gated.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param sessionId: (string) Session id.
 */
export const recordSession = internalMutation({
  args: { requestId: v.id("agentRequests"), sessionId: v.string() },
  handler: async (ctx, { requestId, sessionId }): Promise<null> => {
    if (await ctx.db.get(requestId)) await ctx.db.patch(requestId, { sessionId });
    return null;
  },
});

/**
 * purpose: Start the session (or post to the continued one) with the briefing and message.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: ({ kind: "started", sessionId } | Stop) The session id, or why nothing was started
 *         (paused, cancelled, or failed with a clear error such as missing configuration).
 */
export const startSession = internalAction({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<{ kind: "started"; sessionId: string } | Stop> => {
    const rc: RunContext | null = await ctx.runQuery(internal.agentRuntime.loadContext, {
      requestId,
      withBriefing: true,
    });
    if (!rc) return { kind: "cancelled" };
    const stop = stopForGate(rc.gate);
    if (stop) return stop;
    if (rc.sessionId) return { kind: "started", sessionId: rc.sessionId };
    try {
      const config = readAgentConfig();
      const text = `${rc.briefing ?? ""}\n\nCaregiver's request:\n${rc.message}`;
      if (rc.continues) {
        if (!rc.continueSessionId) {
          return { kind: "failed", error: "The earlier conversation has no session to continue" };
        }
        await sendUserMessage(rc.continueSessionId, text);
        return { kind: "started", sessionId: rc.continueSessionId };
      }
      const sessionId = await createSession(config, {
        title: `Household ${rc.householdId.slice(0, 8)}: caregiver request`,
        requestId,
        householdId: rc.householdId,
        text,
      });
      return { kind: "started", sessionId };
    } catch (e) {
      return { kind: "failed", error: clip(e instanceof Error ? e.message : String(e)) };
    }
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
 * purpose: Watch a session until it needs something from us or the window ends.
 * @param sessionId: (string) Session id.
 * @param sentToolUseIds: (ReadonlySet<string>) Tool calls whose results were already sent;
 *        ignored even if the event list (which can lag) still shows them pending.
 * @param windowMs: (number) How long to keep polling.
 * @param intervalMs: (number) Delay between reads.
 * @return: (Promise<PollResult>) tools (unanswered calls), replied, failed (terminated or
 *         stopped without finishing) or running (window ended, session still working).
 */
export async function pollUntil(
  sessionId: string,
  sentToolUseIds: ReadonlySet<string>,
  windowMs: number,
  intervalMs: number,
): Promise<PollResult> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const status = await getSessionStatus(sessionId);
    if (status === "terminated") {
      return { kind: "failed", error: `Agent session ${sessionId} terminated` };
    }
    if (status === "idle") {
      const events = await listSessionEvents(sessionId);
      const pending = pendingToolUses(events).filter((e) => !sentToolUseIds.has(e.id));
      if (pending.length) {
        return {
          kind: "tools",
          calls: pending.map((e) => ({
            toolUseId: e.id,
            name: e.name ?? "",
            input: e.input ?? {},
          })),
        };
      }
      const turn = finishedTurn(events);
      if (turn.state === "stopped") {
        return { kind: "failed", error: `The agent stopped without finishing (${turn.reason})` };
      }
      if (turn.state === "replied") return { kind: "replied", reply: turn.reply };
    }
    if (Date.now() + intervalMs >= deadline) return { kind: "running" };
    await sleep(intervalMs);
  }
}

/**
 * purpose: One poll step: check the gate, then watch the session for up to POLL_WINDOW_MS.
 *          Transient API errors throw so the workflow retries the step.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param sessionId: (string) Session id.
 * @return: (PollResult | Stop) What the session needs, or why the step did not act.
 */
export const pollSession = internalAction({
  args: { requestId: v.id("agentRequests"), sessionId: v.string() },
  handler: async (ctx, { requestId, sessionId }): Promise<PollResult | Stop> => {
    const rc: RunContext | null = await ctx.runQuery(internal.agentRuntime.loadContext, {
      requestId,
      withBriefing: false,
    });
    if (!rc) return { kind: "cancelled" };
    const stop = stopForGate(rc.gate);
    if (stop) return stop;
    return await pollUntil(sessionId, new Set(rc.sentToolUseIds), POLL_WINDOW_MS, POLL_INTERVAL_MS);
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
  args: { requestId: v.id("agentRequests"), calls: v.array(toolCallValidator) },
  handler: async (ctx, { requestId, calls }): Promise<{ kind: "ok" } | Stop> => {
    const now = Date.now();
    const stop = stopForGate(await readGate(ctx, requestId, now));
    if (stop) return stop;
    const request = await ctx.db.get(requestId);
    if (!request) return { kind: "cancelled" };
    for (const call of calls) {
      await runToolOnce(ctx, request.householdId, requestId, call, now);
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
  const existing = await ctx.db
    .query("agentToolCalls")
    .withIndex("by_request_tool", (q) =>
      q.eq("requestId", requestId).eq("toolUseId", call.toolUseId),
    )
    .unique();
  if (existing) return;
  const result = await executeAgentTool(ctx, householdId, call.name, call.input, now);
  await ctx.db.insert("agentToolCalls", {
    requestId,
    toolUseId: call.toolUseId,
    name: call.name,
    input: call.input,
    text: result.text,
    isError: result.isError,
  });
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
    const results: ToolResult[] = [];
    for (const toolUseId of toolUseIds) {
      const row = await ctx.db
        .query("agentToolCalls")
        .withIndex("by_request_tool", (q) =>
          q.eq("requestId", requestId).eq("toolUseId", toolUseId),
        )
        .unique();
      if (row) results.push({ toolUseId, text: row.text, isError: row.isError });
    }
    return results;
  },
});

/**
 * purpose: Send the stored results of the given tool calls to the session in one request.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param sessionId: (string) Session id.
 * @param toolUseIds: (string[]) Calls to answer.
 * @return: ({ kind: "sent" } | Stop) Stop when paused or cancelled, or failed with the API error.
 */
export const sendToolResults = internalAction({
  args: {
    requestId: v.id("agentRequests"),
    sessionId: v.string(),
    toolUseIds: v.array(v.string()),
  },
  handler: async (ctx, { requestId, sessionId, toolUseIds }): Promise<{ kind: "sent" } | Stop> => {
    const rc: RunContext | null = await ctx.runQuery(internal.agentRuntime.loadContext, {
      requestId,
      withBriefing: false,
    });
    if (!rc) return { kind: "cancelled" };
    const stop = stopForGate(rc.gate);
    if (stop) return stop;
    const results: ToolResult[] = await ctx.runQuery(internal.agentRuntime.storedResults, {
      requestId,
      toolUseIds,
    });
    if (results.length !== toolUseIds.length) {
      return { kind: "failed", error: "A tool result was missing when it was time to send it" };
    }
    try {
      await sendToolResultsToSession(sessionId, results);
    } catch (e) {
      return { kind: "failed", error: clip(e instanceof Error ? e.message : String(e)) };
    }
    return { kind: "sent" };
  },
});

/**
 * purpose: Mark tool results as sent so later polls ignore the calls even if the session's
 *          event list lags.
 * @param requestId: (Id<"agentRequests">) The request.
 * @param toolUseIds: (string[]) Calls whose results were sent.
 */
export const markToolsSent = internalMutation({
  args: { requestId: v.id("agentRequests"), toolUseIds: v.array(v.string()) },
  handler: async (ctx, { requestId, toolUseIds }): Promise<null> => {
    const now = Date.now();
    for (const toolUseId of toolUseIds) {
      const row = await ctx.db
        .query("agentToolCalls")
        .withIndex("by_request_tool", (q) =>
          q.eq("requestId", requestId).eq("toolUseId", toolUseId),
        )
        .unique();
      if (row && row.sentAt === undefined) await ctx.db.patch(row._id, { sentAt: now });
    }
    return null;
  },
});

/**
 * purpose: Write the outcome of a request. Does nothing unless it is still queued or running
 *          (a caregiver cancel wins over a late result).
 * @param requestId: (Id<"agentRequests">) The request.
 * @param status: ("succeeded" | "failed") Outcome.
 * @param reply: (string, optional) The agent's reply when succeeded.
 * @param error: (string, optional) The reason when failed.
 */
export const finishRequest = internalMutation({
  args: {
    requestId: v.id("agentRequests"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    reply: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, status, reply, error }): Promise<null> => {
    const request = await ctx.db.get(requestId);
    if (!request || (request.status !== "queued" && request.status !== "running")) return null;
    await ctx.db.patch(requestId, {
      status,
      reply: status === "succeeded" ? reply : undefined,
      error: status === "failed" ? clip(error ?? "The agent request failed") : undefined,
      finishedAt: Date.now(),
    });
    return null;
  },
});

/**
 * purpose: Workflow completion handler: if the workflow errored or was cancelled while the
 *          request is still queued or running, mark the request failed or cancelled.
 * @param workflowId: (WorkflowId) The workflow that ended.
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
    const request = await ctx.db.get(context.requestId);
    if (!request || (request.status !== "queued" && request.status !== "running")) return null;
    if (result.kind === "canceled") {
      await ctx.db.patch(context.requestId, { status: "cancelled", finishedAt: Date.now() });
      return null;
    }
    const error =
      result.kind === "failed"
        ? clip(`The agent run failed: ${result.error}`)
        : "The agent run ended without a result";
    await ctx.db.patch(context.requestId, { status: "failed", error, finishedAt: Date.now() });
    return null;
  },
});

/**
 * purpose: The workflow for one request. See the file header for the step layout.
 * @param requestId: (Id<"agentRequests">) The request to run.
 */
export const run = workflow.define({
  args: { requestId: v.id("agentRequests") },
  handler: async (step, { requestId }): Promise<null> => {
    const started = await step.runMutation(internal.agentRuntime.markRunning, { requestId });
    if (started.kind === "cancelled") return null;

    const fail = async (error: string): Promise<null> => {
      await step.runMutation(internal.agentRuntime.finishRequest, {
        requestId,
        status: "failed",
        error,
      });
      return null;
    };

    let sessionId: string | null = null;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let stop: Stop;
      if (sessionId === null) {
        const begun = await step.runAction(internal.agentRuntime.startSession, { requestId });
        if (begun.kind === "started") {
          sessionId = begun.sessionId;
          await step.runMutation(internal.agentRuntime.recordSession, { requestId, sessionId });
          continue;
        }
        stop = begun;
      } else {
        const polled = await step.runAction(
          internal.agentRuntime.pollSession,
          { requestId, sessionId },
          { retry: true },
        );
        if (polled.kind === "running") continue;
        if (polled.kind === "replied") {
          await step.runMutation(internal.agentRuntime.finishRequest, {
            requestId,
            status: "succeeded",
            reply: polled.reply,
          });
          return null;
        }
        if (polled.kind !== "tools") {
          stop = polled;
        } else {
          const toolUseIds = polled.calls.map((c) => c.toolUseId);
          const ran = await step.runMutation(internal.agentRuntime.executeToolCalls, {
            requestId,
            calls: polled.calls,
          });
          if (ran.kind !== "ok") {
            stop = ran;
          } else {
            const sent = await step.runAction(internal.agentRuntime.sendToolResults, {
              requestId,
              sessionId,
              toolUseIds,
            });
            if (sent.kind !== "sent") {
              stop = sent;
            } else {
              await step.runMutation(internal.agentRuntime.markToolsSent, {
                requestId,
                toolUseIds,
              });
              continue;
            }
          }
        }
      }
      if (stop.kind === "failed") return await fail(stop.error);
      if (stop.kind === "cancelled") return null;
      await step.sleep(PAUSE_RECHECK_MS);
    }
    return await fail("The agent run took too many steps");
  },
});
