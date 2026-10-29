// lib/managedAgents.test.ts
// Purpose: Tests for the pure parts of lib/managedAgents.ts, ported from the behavior of
// supabase/functions/jobs-run/agent.ts: pendingToolUses (calls without a result) and
// finishedTurn (running while the session works or waits for tool results, replied at end of
// turn with the joined agent text or "Done.", stopped for any other idle reason, and only the
// turn after the latest user message counts), plus readAgentConfig (missing variables are
// named, the session budget defaults to 100 cents and ignores invalid values).
//
// Last modified: 2026-10-29

import { describe, expect, test } from "vitest";
import {
  countUserMessages,
  finishedTurn,
  pendingToolUses,
  readAgentConfig,
  type SessionEvent,
} from "./managedAgents";

/**
 * purpose: A user.message event.
 * @param id: (string) Event id.
 * @return: (SessionEvent) The event.
 */
function userMessage(id = "u1"): SessionEvent {
  return { id, type: "user.message" };
}

/**
 * purpose: An agent.custom_tool_use event.
 * @param id: (string) Event id (the tool use id).
 * @return: (SessionEvent) The event.
 */
function toolUse(id: string): SessionEvent {
  return { id, type: "agent.custom_tool_use", name: "get_calendar", input: { from_date: "x" } };
}

/**
 * purpose: A user.custom_tool_result event answering a tool use.
 * @param toolUseId: (string) The answered tool use id.
 * @return: (SessionEvent) The event.
 */
function toolResult(toolUseId: string): SessionEvent {
  return { id: `r_${toolUseId}`, type: "user.custom_tool_result", custom_tool_use_id: toolUseId };
}

/**
 * purpose: An agent.message event with text blocks.
 * @param texts: (string[]) Text blocks.
 * @return: (SessionEvent) The event.
 */
function agentMessage(...texts: string[]): SessionEvent {
  return {
    id: `m_${texts.join("").length}_${texts[0] ?? ""}`,
    type: "agent.message",
    content: texts.map((text) => ({ type: "text", text })),
  };
}

/**
 * purpose: A session.status_idle event.
 * @param reason: (string) Stop reason type.
 * @param id: (string) Event id.
 * @return: (SessionEvent) The event.
 */
function idle(reason: string, id = "i1"): SessionEvent {
  return { id, type: "session.status_idle", stop_reason: { type: reason } };
}

describe("pendingToolUses", () => {
  test("returns tool uses without a result, in order", () => {
    const events = [userMessage(), toolUse("a"), toolUse("b"), toolResult("a")];
    expect(pendingToolUses(events).map((e) => e.id)).toEqual(["b"]);
  });

  test("returns nothing when every call is answered", () => {
    expect(pendingToolUses([toolUse("a"), toolResult("a")])).toEqual([]);
  });

  test("returns nothing for an empty list", () => {
    expect(pendingToolUses([])).toEqual([]);
  });

  test("ignores other event types", () => {
    expect(pendingToolUses([userMessage(), agentMessage("hi"), idle("end_turn")])).toEqual([]);
  });
});

describe("finishedTurn", () => {
  test("is running with no idle event", () => {
    expect(finishedTurn([userMessage(), toolUse("a")])).toEqual({ state: "running" });
  });

  test("is running when idle waits on tool results", () => {
    expect(finishedTurn([userMessage(), toolUse("a"), idle("requires_action")])).toEqual({
      state: "running",
    });
  });

  test("is replied with the agent text at end of turn", () => {
    expect(finishedTurn([userMessage(), agentMessage("Added it."), idle("end_turn")])).toEqual({
      state: "replied",
      reply: "Added it.",
    });
  });

  test("joins several text blocks and messages with newlines and trims", () => {
    const events = [
      userMessage(),
      agentMessage("  First ", "second"),
      agentMessage("third  "),
      idle("end_turn"),
    ];
    expect(finishedTurn(events)).toEqual({ state: "replied", reply: "First \nsecond\nthird" });
  });

  test("replies Done. when the agent said nothing", () => {
    expect(finishedTurn([userMessage(), idle("end_turn")])).toEqual({
      state: "replied",
      reply: "Done.",
    });
  });

  test("is stopped for a budget or other non end_turn stop", () => {
    expect(finishedTurn([userMessage(), idle("retries_exhausted")])).toEqual({
      state: "stopped",
      reason: "retries_exhausted",
    });
  });

  test("is stopped with reason unknown when the stop reason is missing", () => {
    expect(finishedTurn([userMessage(), { id: "i", type: "session.status_idle" }])).toEqual({
      state: "stopped",
      reason: "unknown",
    });
  });

  test("only the turn after the latest user message counts", () => {
    const events = [
      userMessage("u1"),
      agentMessage("Old answer"),
      idle("end_turn", "i1"),
      userMessage("u2"),
      toolUse("a"),
    ];
    expect(finishedTurn(events)).toEqual({ state: "running" });
  });

  test("a continued conversation replies with the new turn's text only", () => {
    const events = [
      userMessage("u1"),
      agentMessage("Old answer"),
      idle("end_turn", "i1"),
      userMessage("u2"),
      agentMessage("New answer"),
      idle("end_turn", "i2"),
    ];
    expect(finishedTurn(events)).toEqual({ state: "replied", reply: "New answer" });
  });
});

describe("finishedTurn with a baseline", () => {
  const oldTurn = [userMessage("u1"), agentMessage("Old answer"), idle("end_turn", "i1")];

  test("counts user messages", () => {
    expect(countUserMessages(oldTurn)).toBe(1);
    expect(countUserMessages([])).toBe(0);
  });

  test("is running while the new message is not visible yet", () => {
    expect(finishedTurn(oldTurn, 1)).toEqual({ state: "running" });
  });

  test("is running for a new session whose first message is not visible yet", () => {
    expect(finishedTurn([])).toEqual({ state: "running" });
  });

  test("replies once the new message and its answer are visible", () => {
    const events = [
      ...oldTurn,
      userMessage("u2"),
      agentMessage("New answer"),
      idle("end_turn", "i2"),
    ];
    expect(finishedTurn(events, 1)).toEqual({ state: "replied", reply: "New answer" });
  });

  test("is running when the new message is visible but unanswered", () => {
    expect(finishedTurn([...oldTurn, userMessage("u2")], 1)).toEqual({ state: "running" });
  });
});

describe("readAgentConfig", () => {
  const full = {
    ANTHROPIC_API_KEY: "key",
    SUNNY_AGENT_ID: "agent_1",
    SUNNY_ENVIRONMENT_ID: "env_1",
  };

  test("reads the three ids and defaults the budget to 100 cents", () => {
    expect(readAgentConfig(full)).toEqual({
      apiKey: "key",
      agentId: "agent_1",
      environmentId: "env_1",
      budgetCents: 100,
    });
  });

  test("uses a valid budget override", () => {
    expect(readAgentConfig({ ...full, SUNNY_AGENT_SESSION_BUDGET_CENTS: "250" }).budgetCents).toBe(
      250,
    );
  });

  test.each(["0", "-5", "1.5", "abc"])("falls back to 100 for budget %s", (value) => {
    expect(readAgentConfig({ ...full, SUNNY_AGENT_SESSION_BUDGET_CENTS: value }).budgetCents).toBe(
      100,
    );
  });

  test("names every missing variable", () => {
    expect(() => readAgentConfig({ SUNNY_AGENT_ID: "agent_1" })).toThrow(/not configured/);
    expect(() => readAgentConfig({ SUNNY_AGENT_ID: "agent_1" })).toThrow(
      /ANTHROPIC_API_KEY, SUNNY_ENVIRONMENT_ID/,
    );
  });
});
