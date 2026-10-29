// agentRuntime.test.ts
// Purpose: Tests for agentRuntime.ts. The workflow component is registered in convex-test and
// lib/managedAgents (the network wrapper) and lib/agentTools (part A's tools) are replaced by
// mocks, so no real API is called; the tool double inserts an audit row as its observable
// effect. End to end through the real workflow: a request whose poll returns a tool call,
// where a lagging event list shows the same call again, writes exactly one effect and one
// result, then stores the reply and succeeds; a continued request posts to the earlier
// session; the agent stopping or its session terminating fails the request with the reason;
// a missing environment fails with a clear message; a paused household waits and then resumes;
// a request older than 30 minutes fails; a cancel ends the run. Plus the step functions
// directly: executeToolCalls reuses a stored result, pollUntil's outcomes, the paused gate on
// every acting step, and the onComplete handler.
//
// Last modified: 2026-10-29

import { convexTest } from "convex-test";
import workflowTest from "@convex-dev/workflow/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_REQUEST_AGE_MS, PAUSE_RECHECK_MS, pollUntil, TIMEOUT_ERROR } from "./agentRuntime";
import type { SessionEvent } from "./lib/managedAgents";
import schema from "./schema";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendUserMessage: vi.fn(),
  sendToolResults: vi.fn(),
  getSessionStatus: vi.fn(),
  listSessionEvents: vi.fn(),
  executeAgentTool: vi.fn(),
}));

vi.mock("./lib/managedAgents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/managedAgents")>()),
  createSession: mocks.createSession,
  sendUserMessage: mocks.sendUserMessage,
  sendToolResults: mocks.sendToolResults,
  getSessionStatus: mocks.getSessionStatus,
  listSessionEvents: mocks.listSessionEvents,
}));

vi.mock("./lib/agentTools", () => ({
  AGENT_TOOLS: [],
  executeAgentTool: mocks.executeAgentTool,
}));

/** Every non-test module in the backend, for the convex-test harness. */
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const ENV_NAMES = ["ANTHROPIC_API_KEY", "SUNNY_AGENT_ID", "SUNNY_ENVIRONMENT_ID"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers();
  savedEnv = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SUNNY_AGENT_ID = "agent_test";
  process.env.SUNNY_ENVIRONMENT_ID = "env_test";
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createSession.mockResolvedValue("sess_1");
  mocks.getSessionStatus.mockResolvedValue("idle");
  mocks.sendToolResults.mockResolvedValue(undefined);
  mocks.sendUserMessage.mockResolvedValue(undefined);
  // The tool double: one audit row per real execution, so repeats are countable.
  mocks.executeAgentTool.mockImplementation(async (ctx, householdId, name) => {
    await ctx.db.insert("auditLog", {
      householdId,
      actorKind: "agent",
      action: "test_tool",
      entity: name,
      detail: {},
    });
    return { text: `ran ${name}`, isError: false };
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

/**
 * purpose: A fresh in-memory backend with the workflow component registered.
 * @return: The convex-test harness typed with the schema.
 */
function makeBackend() {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  return t;
}

/** The convex-test harness type, with the schema's table types. */
type TestConvex = ReturnType<typeof makeBackend>;

/**
 * purpose: Create a household owned by user_a.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<Id<"households">>) The household.
 */
async function createHousehold(t: TestConvex): Promise<Id<"households">> {
  return await t.withIdentity({ subject: "user_a" }).mutation(api.households.create, {
    seniorPreferredName: "Margaret",
    timezone: "America/New_York",
    caregiverDisplayName: "Anna",
  });
}

/**
 * purpose: Create a household and queue a request through the public API.
 * @param t: (TestConvex) Harness.
 * @param extra: ({ continueRequestId }) Optional continuation.
 * @return: (Promise<{ householdId, requestId }>) The ids.
 */
async function startRequest(
  t: TestConvex,
  extra: { continueRequestId?: Id<"agentRequests"> } = {},
) {
  const householdId = await createHousehold(t);
  const requestId = await t
    .withIdentity({ subject: "user_a" })
    .mutation(api.agentRequests.request, { householdId, message: "Add lunch at noon", ...extra });
  return { householdId, requestId };
}

/**
 * purpose: Run scheduled functions (workflow steps and sleeps) in small clock steps until
 *          every request has finished. Small steps keep the fake clock near real elapsed
 *          time; running all timers would jump it past the 30 minute cap through the
 *          workpool's recurring bookkeeping.
 * @param t: (TestConvex) Harness.
 */
async function drain(t: TestConvex): Promise<void> {
  for (let i = 0; i < 400; i++) {
    // A poll step may sleep on the fake clock, so keep the clock moving while it finishes.
    let finished = false;
    void t.finishInProgressScheduledFunctions().then(() => {
      finished = true;
    });
    while (!finished) await vi.advanceTimersByTimeAsync(250);
    const open = await t.run(async (ctx) => {
      const rows = await ctx.db.query("agentRequests").collect();
      return rows.filter((r) => r.status === "queued" || r.status === "running").length;
    });
    if (open === 0) return;
    await vi.advanceTimersByTimeAsync(1_100);
  }
  throw new Error("requests did not finish");
}

/**
 * purpose: Read a request row.
 * @param t: (TestConvex) Harness.
 * @param requestId: (Id<"agentRequests">) The request.
 * @return: The row.
 */
async function getRequest(t: TestConvex, requestId: Id<"agentRequests">) {
  return await t.run(async (ctx) => await ctx.db.get(requestId));
}

/**
 * purpose: Count audit rows written by the tool double.
 * @param t: (TestConvex) Harness.
 * @return: (Promise<number>) Number of real tool executions.
 */
async function toolEffects(t: TestConvex): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("auditLog").collect();
    return rows.filter((r) => r.action === "test_tool").length;
  });
}

const userMessage: SessionEvent = { id: "u1", type: "user.message" };
const toolUse: SessionEvent = {
  id: "tu1",
  type: "agent.custom_tool_use",
  name: "add_event",
  input: { title: "Lunch" },
};
const needsTools: SessionEvent[] = [
  userMessage,
  toolUse,
  { id: "i1", type: "session.status_idle", stop_reason: { type: "requires_action" } },
];
const answered: SessionEvent[] = [
  userMessage,
  toolUse,
  { id: "r1", type: "user.custom_tool_result", custom_tool_use_id: "tu1" },
  {
    id: "m1",
    type: "agent.message",
    content: [{ type: "text", text: "Lunch is on the calendar." }],
  },
  { id: "i2", type: "session.status_idle", stop_reason: { type: "end_turn" } },
];
const repliedOnly: SessionEvent[] = [
  userMessage,
  { id: "m1", type: "agent.message", content: [{ type: "text", text: "All set." }] },
  { id: "i2", type: "session.status_idle", stop_reason: { type: "end_turn" } },
];

/**
 * purpose: Make listSessionEvents return successive snapshots, repeating the last.
 * @param snapshots: (SessionEvent[][]) Event lists, one per call.
 */
function scriptEvents(...snapshots: SessionEvent[][]): void {
  let call = 0;
  mocks.listSessionEvents.mockImplementation(async () => {
    const snapshot = snapshots[Math.min(call, snapshots.length - 1)];
    call += 1;
    return snapshot;
  });
}

describe("workflow end to end", () => {
  test("replies without tools: succeeded with the reply and session id", async () => {
    const t = makeBackend();
    scriptEvents(repliedOnly);
    const { requestId, householdId } = await startRequest(t);
    await drain(t);
    const row = await getRequest(t, requestId);
    expect(row).toMatchObject({ status: "succeeded", reply: "All set.", sessionId: "sess_1" });
    expect(row?.finishedAt).toBeTypeOf("number");
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    const args = mocks.createSession.mock.calls[0]!;
    expect(args[0]).toMatchObject({ agentId: "agent_test", environmentId: "env_test" });
    expect(args[1]).toMatchObject({ requestId, householdId });
    expect(args[1].text).toMatch(
      /^Household briefing:[\s\S]*\n\nCaregiver's request:\nAdd lunch at noon$/,
    );
  });

  test("a tool call polled twice runs once, sends once and then succeeds", async () => {
    const t = makeBackend();
    // Poll 1 sees the call; after we send the result the event list still lags (shows the
    // call unanswered) once, then catches up with the result and the reply.
    scriptEvents(needsTools, needsTools, answered);
    const { requestId } = await startRequest(t);
    await drain(t);

    const row = await getRequest(t, requestId);
    expect(row).toMatchObject({ status: "succeeded", reply: "Lunch is on the calendar." });
    expect(await toolEffects(t)).toBe(1);
    expect(mocks.executeAgentTool).toHaveBeenCalledTimes(1);
    expect(mocks.executeAgentTool.mock.calls[0]![2]).toBe("add_event");
    expect(mocks.executeAgentTool.mock.calls[0]![3]).toEqual({ title: "Lunch" });
    expect(mocks.sendToolResults).toHaveBeenCalledTimes(1);
    expect(mocks.sendToolResults).toHaveBeenCalledWith("sess_1", [
      { toolUseId: "tu1", text: "ran add_event", isError: false },
    ]);
    const calls = await t.run(async (ctx) => await ctx.db.query("agentToolCalls").collect());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sentAt).toBeTypeOf("number");
  });

  test("a continued request posts to the earlier session instead of creating one", async () => {
    const t = makeBackend();
    scriptEvents(repliedOnly);
    const householdId = await createHousehold(t);
    const earlier = await t.run(async (ctx) => {
      return await ctx.db.insert("agentRequests", {
        householdId,
        requestedBy: "user_a",
        message: "first",
        status: "succeeded",
        sessionId: "sess_old",
      });
    });
    const requestId = await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.agentRequests.request, {
        householdId,
        message: "and also dinner",
        continueRequestId: earlier,
      });
    await drain(t);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendUserMessage.mock.calls[0]![0]).toBe("sess_old");
    expect(mocks.sendUserMessage.mock.calls[0]![1]).toMatch(
      /Caregiver's request:\nand also dinner$/,
    );
    expect(await getRequest(t, requestId)).toMatchObject({
      status: "succeeded",
      sessionId: "sess_old",
    });
  });

  test("the agent stopping without finishing fails the request with the reason", async () => {
    const t = makeBackend();
    scriptEvents([
      userMessage,
      { id: "i", type: "session.status_idle", stop_reason: { type: "budget_exceeded" } },
    ]);
    const { requestId } = await startRequest(t);
    await drain(t);
    const row = await getRequest(t, requestId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("The agent stopped without finishing (budget_exceeded)");
    expect(row?.reply).toBeUndefined();
  });

  test("a terminated session fails the request", async () => {
    const t = makeBackend();
    mocks.getSessionStatus.mockResolvedValue("terminated");
    const { requestId } = await startRequest(t);
    await drain(t);
    const row = await getRequest(t, requestId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("Agent session sess_1 terminated");
  });

  test("missing environment fails clearly without calling the API", async () => {
    const t = makeBackend();
    delete process.env.SUNNY_AGENT_ID;
    delete process.env.SUNNY_ENVIRONMENT_ID;
    const { requestId } = await startRequest(t);
    await drain(t);
    const row = await getRequest(t, requestId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(
      "The agent is not configured: set SUNNY_AGENT_ID, SUNNY_ENVIRONMENT_ID on the Convex deployment",
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  test("an API error while creating the session fails the request with its message", async () => {
    const t = makeBackend();
    mocks.createSession.mockRejectedValue(new Error("529 overloaded"));
    const { requestId } = await startRequest(t);
    await drain(t);
    expect(await getRequest(t, requestId)).toMatchObject({
      status: "failed",
      error: "529 overloaded",
    });
  });

  test("a paused household waits, does nothing, and resumes when unpaused", async () => {
    const t = makeBackend();
    scriptEvents(repliedOnly);
    const householdId = await createHousehold(t);
    await t.run(async (ctx) => await ctx.db.patch(householdId, { backgroundPaused: true }));
    const requestId = await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.agentRequests.request, { householdId, message: "hi" });

    // Let the first steps and a few 60 second sleeps run while paused.
    await t.finishInProgressScheduledFunctions();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(PAUSE_RECHECK_MS + 1);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await getRequest(t, requestId)).toMatchObject({ status: "running" });
    expect(mocks.createSession).not.toHaveBeenCalled();

    await t.run(async (ctx) => await ctx.db.patch(householdId, { backgroundPaused: false }));
    await vi.advanceTimersByTimeAsync(PAUSE_RECHECK_MS + 1);
    await drain(t);
    expect(await getRequest(t, requestId)).toMatchObject({
      status: "succeeded",
      reply: "All set.",
    });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  test("a request older than 30 minutes fails with the timeout error", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    await t.run(async (ctx) => await ctx.db.patch(householdId, { backgroundPaused: true }));
    const requestId = await t
      .withIdentity({ subject: "user_a" })
      .mutation(api.agentRequests.request, { householdId, message: "hi" });
    await t.finishInProgressScheduledFunctions();
    await vi.advanceTimersByTimeAsync(MAX_REQUEST_AGE_MS + PAUSE_RECHECK_MS * 2);
    await drain(t);
    expect(await getRequest(t, requestId)).toMatchObject({
      status: "failed",
      error: TIMEOUT_ERROR,
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  test("cancelling stops the run and leaves the request cancelled", async () => {
    const t = makeBackend();
    const { requestId } = await startRequest(t);
    await t.withIdentity({ subject: "user_a" }).mutation(api.agentRequests.cancel, { requestId });
    await drain(t);
    expect(await getRequest(t, requestId)).toMatchObject({ status: "cancelled" });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe("step functions", () => {
  /**
   * purpose: A running request with a session, for calling steps directly.
   * @param t: (TestConvex) Harness.
   * @return: The ids.
   */
  async function runningRequest(t: TestConvex) {
    const householdId = await createHousehold(t);
    const requestId = await t.run(async (ctx) => {
      return await ctx.db.insert("agentRequests", {
        householdId,
        requestedBy: "user_a",
        message: "hi",
        status: "running",
        sessionId: "sess_1",
      });
    });
    return { householdId, requestId };
  }

  const call = { toolUseId: "tu1", name: "add_event", input: { title: "Lunch" } };

  test("executeToolCalls runs a call once and keeps the stored result on repeat", async () => {
    const t = makeBackend();
    const { requestId } = await runningRequest(t);
    expect(
      await t.mutation(internal.agentRuntime.executeToolCalls, { requestId, calls: [call] }),
    ).toEqual({
      kind: "ok",
    });
    mocks.executeAgentTool.mockResolvedValue({ text: "different", isError: true });
    await t.mutation(internal.agentRuntime.executeToolCalls, { requestId, calls: [call] });
    expect(mocks.executeAgentTool).toHaveBeenCalledTimes(1);
    const stored = await t.query(internal.agentRuntime.storedResults, {
      requestId,
      toolUseIds: ["tu1"],
    });
    expect(stored).toEqual([{ toolUseId: "tu1", text: "ran add_event", isError: false }]);
  });

  test("executeToolCalls takes the household from the request, not the model", async () => {
    const t = makeBackend();
    const { requestId, householdId } = await runningRequest(t);
    await t.mutation(internal.agentRuntime.executeToolCalls, {
      requestId,
      calls: [{ ...call, input: { household_id: "someone_else" } }],
    });
    expect(mocks.executeAgentTool.mock.calls[0]![1]).toBe(householdId);
  });

  test("executeToolCalls does not act while paused or after cancellation", async () => {
    const t = makeBackend();
    const { requestId, householdId } = await runningRequest(t);
    await t.run(async (ctx) => await ctx.db.patch(householdId, { backgroundPaused: true }));
    expect(
      await t.mutation(internal.agentRuntime.executeToolCalls, { requestId, calls: [call] }),
    ).toEqual({
      kind: "paused",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(householdId, { backgroundPaused: false });
      await ctx.db.patch(requestId, { status: "cancelled" });
    });
    expect(
      await t.mutation(internal.agentRuntime.executeToolCalls, { requestId, calls: [call] }),
    ).toEqual({
      kind: "cancelled",
    });
    expect(mocks.executeAgentTool).not.toHaveBeenCalled();
  });

  test("pollSession and sendToolResults do not call the API while paused", async () => {
    const t = makeBackend();
    const { requestId, householdId } = await runningRequest(t);
    await t.run(async (ctx) => await ctx.db.patch(householdId, { backgroundPaused: true }));
    expect(
      await t.action(internal.agentRuntime.pollSession, { requestId, sessionId: "sess_1" }),
    ).toEqual({
      kind: "paused",
    });
    expect(
      await t.action(internal.agentRuntime.sendToolResults, {
        requestId,
        sessionId: "sess_1",
        toolUseIds: ["tu1"],
      }),
    ).toEqual({ kind: "paused" });
    expect(await t.action(internal.agentRuntime.startSession, { requestId })).toEqual({
      kind: "paused",
    });
    expect(mocks.getSessionStatus).not.toHaveBeenCalled();
    expect(mocks.sendToolResults).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  test("sendToolResults fails clearly when a stored result is missing", async () => {
    const t = makeBackend();
    const { requestId } = await runningRequest(t);
    const result = await t.action(internal.agentRuntime.sendToolResults, {
      requestId,
      sessionId: "sess_1",
      toolUseIds: ["nope"],
    });
    expect(result).toMatchObject({ kind: "failed" });
    expect(mocks.sendToolResults).not.toHaveBeenCalled();
  });

  test("markToolsSent stamps sentAt once", async () => {
    const t = makeBackend();
    const { requestId } = await runningRequest(t);
    await t.mutation(internal.agentRuntime.executeToolCalls, { requestId, calls: [call] });
    await t.mutation(internal.agentRuntime.markToolsSent, { requestId, toolUseIds: ["tu1"] });
    const first = await t.run(
      async (ctx) => (await ctx.db.query("agentToolCalls").first())?.sentAt,
    );
    vi.advanceTimersByTime(5_000);
    await t.mutation(internal.agentRuntime.markToolsSent, { requestId, toolUseIds: ["tu1"] });
    const second = await t.run(
      async (ctx) => (await ctx.db.query("agentToolCalls").first())?.sentAt,
    );
    expect(first).toBeTypeOf("number");
    expect(second).toBe(first);
  });

  test("finishRequest does not overwrite a cancelled request", async () => {
    const t = makeBackend();
    const { requestId } = await runningRequest(t);
    await t.run(async (ctx) => await ctx.db.patch(requestId, { status: "cancelled" }));
    await t.mutation(internal.agentRuntime.finishRequest, {
      requestId,
      status: "succeeded",
      reply: "late",
    });
    expect(await getRequest(t, requestId)).toMatchObject({ status: "cancelled" });
  });

  describe("onRunComplete", () => {
    const base = { workflowId: "wf" };

    test("marks a still-running request failed when the workflow failed", async () => {
      const t = makeBackend();
      const { requestId } = await runningRequest(t);
      await t.mutation(internal.agentRuntime.onRunComplete, {
        ...base,
        result: { kind: "failed", error: "boom" },
        context: { requestId },
      });
      expect(await getRequest(t, requestId)).toMatchObject({
        status: "failed",
        error: "The agent run failed: boom",
      });
    });

    test("marks a still-running request cancelled when the workflow was cancelled", async () => {
      const t = makeBackend();
      const { requestId } = await runningRequest(t);
      await t.mutation(internal.agentRuntime.onRunComplete, {
        ...base,
        result: { kind: "canceled" },
        context: { requestId },
      });
      expect(await getRequest(t, requestId)).toMatchObject({ status: "cancelled" });
    });

    test("leaves a finished request alone", async () => {
      const t = makeBackend();
      const { requestId } = await runningRequest(t);
      await t.run(async (ctx) => ctx.db.patch(requestId, { status: "succeeded", reply: "ok" }));
      await t.mutation(internal.agentRuntime.onRunComplete, {
        ...base,
        result: { kind: "failed", error: "boom" },
        context: { requestId },
      });
      expect(await getRequest(t, requestId)).toMatchObject({ status: "succeeded", reply: "ok" });
    });
  });
});

describe("pollUntil", () => {
  test("returns running when the session never goes idle within the window", async () => {
    mocks.getSessionStatus.mockResolvedValue("running");
    await expect(pollUntil("s", new Set(), 0, 1)).resolves.toEqual({ kind: "running" });
    expect(mocks.listSessionEvents).not.toHaveBeenCalled();
  });

  test("returns running when idle but the turn is waiting on results already sent", async () => {
    scriptEvents(needsTools);
    await expect(pollUntil("s", new Set(["tu1"]), 0, 1)).resolves.toEqual({ kind: "running" });
  });

  test("returns the unanswered calls with name and input", async () => {
    scriptEvents(needsTools);
    await expect(pollUntil("s", new Set(), 0, 1)).resolves.toEqual({
      kind: "tools",
      calls: [{ toolUseId: "tu1", name: "add_event", input: { title: "Lunch" } }],
    });
  });

  test("returns replied, failed for stopped, and failed for terminated", async () => {
    scriptEvents(repliedOnly);
    await expect(pollUntil("s", new Set(), 0, 1)).resolves.toEqual({
      kind: "replied",
      reply: "All set.",
    });
    scriptEvents([
      userMessage,
      { id: "i", type: "session.status_idle", stop_reason: { type: "refusal" } },
    ]);
    await expect(pollUntil("s", new Set(), 0, 1)).resolves.toEqual({
      kind: "failed",
      error: "The agent stopped without finishing (refusal)",
    });
    mocks.getSessionStatus.mockResolvedValue("terminated");
    await expect(pollUntil("s", new Set(), 0, 1)).resolves.toMatchObject({ kind: "failed" });
  });
});
