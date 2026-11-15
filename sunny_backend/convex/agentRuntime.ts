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
import { EDITOR_ROLES, findMember } from "./lib/access";
import { buildBriefing } from "./lib/agentBriefing";
import { buildCarryOver } from "./lib/agentHistory";
import { errorText, GENERIC_ERROR, isInProgress, transitionRequest } from "./lib/agentRequestState";
import { executeAgentTool } from "./lib/agentTools";
import type { ToolContext } from "./lib/toolInput";
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

export const MAX_REQUEST_AGE_MS = 30 * 60_000;
export const PAUSE_RECHECK_MS = 60_000;
export const TIMEOUT_ERROR = "The agent did not finish this request in time";
export const PAUSED_TIMEOUT_ERROR =
  "This request timed out while Sunny's background work was paused. Resume it and ask again.";
const POLL_WINDOW_MS = 4 * 60_000;
const POLL_HARD_LIMIT_MS = 6 * 60_000;
const POLL_START_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 5_000;
const MAX_LOOP_ROUNDS = 200;
export const MAX_CHANGED_TASKS = 20;
const MAX_SENT_LOOKUP = 500;

export const workflow = new WorkflowManager(components.workflow);

export type Gate = "go" | "paused" | "expired" | "expiredWhilePaused" | "cancelled";

export type Failure = { kind: "failed"; error: string; detail?: string };

export type Stop = { kind: "paused" } | { kind: "cancelled" } | Failure;

export type PollResult =
  | { kind: "running" }
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "replied"; reply: string }
  | Failure;

type GateResult = { gate: "go"; request: Doc<"agentRequests"> } | { gate: Exclude<Gate, "go"> };

export type SessionInputs =
  | { stop: Stop }
  | {
      stop: null;
      householdId: Id<"households">;
      text: string;
      sessionId: string | null;
      continueSessionId: string | null;
    };

function failure(detail: string, error: string = GENERIC_ERROR): Failure {
  return { kind: "failed", error, detail };
}

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

export function stopFor(gate: Exclude<Gate, "go">): Stop {
  if (gate === "expired") return { kind: "failed", error: TIMEOUT_ERROR };
  if (gate === "expiredWhilePaused") return { kind: "failed", error: PAUSED_TIMEOUT_ERROR };
  return { kind: gate };
}

async function gateOrStop(ctx: ActionCtx, requestId: Id<"agentRequests">): Promise<Stop | null> {
  const gate: Gate = await ctx.runQuery(internal.agentRuntime.gate, { requestId });
  return gate === "go" ? null : stopFor(gate);
}

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

export const gate = internalQuery({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<Gate> => {
    return (await readGate(ctx, requestId, Date.now())).gate;
  },
});

export const markRunning = internalMutation({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<{ kind: "ok" | "cancelled" }> => {
    const moved = await transitionRequest(ctx, requestId, { status: "running" });
    return { kind: moved ? "ok" : "cancelled" };
  },
});

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
    const started = continueSessionId
      ? request.baselineUserMessages !== undefined
      : request.sessionId !== undefined;
    const briefing = await buildBriefing(ctx, request.householdId, request.requestedBy, now);
    const earlier = request.carryOver ? await buildCarryOver(ctx, request.householdId) : "";
    return {
      stop: null,
      householdId: request.householdId,
      text: `${briefing}\n\n${earlier}Caregiver's request:\n${request.message}`,
      sessionId: started ? (continueSessionId ?? request.sessionId ?? null) : null,
      continueSessionId,
    };
  },
});

export const recordSession = internalMutation({
  args: { requestId: v.id("agentRequests"), sessionId: v.string() },
  handler: async (ctx, { requestId, sessionId }): Promise<null> => {
    if (await ctx.db.get(requestId)) await ctx.db.patch(requestId, { sessionId });
    else
      console.warn(`recordSession: request ${requestId} no longer exists (session ${sessionId})`);
    return null;
  },
});

export const recordBaseline = internalMutation({
  args: { requestId: v.id("agentRequests"), baseline: v.number() },
  handler: async (ctx, { requestId, baseline }): Promise<null> => {
    if (await ctx.db.get(requestId))
      await ctx.db.patch(requestId, { baselineUserMessages: baseline });
    else console.warn(`recordBaseline: request ${requestId} no longer exists`);
    return null;
  },
});

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export const executeToolCalls = internalMutation({
  args: { requestId: v.id("agentRequests"), calls: v.array(toolCall) },
  handler: async (ctx, { requestId, calls }): Promise<{ kind: "ok" } | Stop> => {
    const now = Date.now();
    const g = await readGate(ctx, requestId, now);
    if (g.gate !== "go") return stopFor(g.gate);
    const member = await findMember(ctx, g.request.householdId, g.request.requestedBy);
    if (!member || !EDITOR_ROLES.includes(member.role)) {
      return failure("The requesting caregiver can no longer edit the household");
    }
    const toolCtx: ToolContext = {
      householdId: g.request.householdId,
      actor: { kind: "agent", onBehalfOf: g.request.requestedBy, requestId },
      now,
    };
    for (const call of calls) {
      await runToolOnce(ctx, toolCtx, requestId, call);
    }
    return { kind: "ok" };
  },
});

async function runToolOnce(
  ctx: MutationCtx,
  toolCtx: ToolContext,
  requestId: Id<"agentRequests">,
  call: ToolCall,
): Promise<void> {
  if (await findToolCall(ctx, requestId, call.toolUseId)) return;
  const input = JSON.parse(call.input) as Record<string, unknown>;
  const { text, isError, taskId } = await executeAgentTool(ctx, toolCtx, {
    name: call.name,
    input,
  });
  await ctx.db.insert("agentToolCalls", { requestId, ...call, text, isError });
  if (taskId !== undefined) await recordChangedTask(ctx, requestId, taskId);
}

async function recordChangedTask(
  ctx: MutationCtx,
  requestId: Id<"agentRequests">,
  taskId: Id<"tasks">,
): Promise<void> {
  const request = await ctx.db.get(requestId);
  const changed = request?.changedTaskIds ?? [];
  if (!request || changed.includes(taskId) || changed.length >= MAX_CHANGED_TASKS) return;
  await ctx.db.patch(requestId, { changedTaskIds: [...changed, taskId] });
}

export const storedResults = internalQuery({
  args: { requestId: v.id("agentRequests"), toolUseIds: v.array(v.string()) },
  handler: async (ctx, { requestId, toolUseIds }): Promise<ToolResult[]> => {
    const rows = await Promise.all(toolUseIds.map((id) => findToolCall(ctx, requestId, id)));
    return rows.flatMap((row) =>
      row ? [{ toolUseId: row.toolUseId, text: row.text, isError: row.isError }] : [],
    );
  },
});

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

type Next = null | { kind: "replied"; reply: string } | Stop;

async function startPhase(
  step: WorkflowCtx,
  requestId: Id<"agentRequests">,
): Promise<{ sessionId: string } | Stop> {
  const begun = await step.runAction(internal.agentRuntime.startSession, { requestId });
  return begun.kind === "started" ? { sessionId: begun.sessionId } : begun;
}

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

export const run = workflow.define({
  args: { requestId: v.id("agentRequests") },
  handler: async (step, { requestId }): Promise<null> => {
    const started = await step.runMutation(internal.agentRuntime.markRunning, { requestId });
    if (started.kind === "cancelled") return null;

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
