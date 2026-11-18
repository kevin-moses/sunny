import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import {
  ESCALATION_LADDER,
  PROMPT_ONLY_LADDER,
  alertsCaregivers,
  escalationSteps,
  stepDueAt,
  stepHeld,
  upcomingPromptTimes,
} from "./escalation";
import type { PromptTiming } from "./escalation";

const MIN = 60_000;
const START = 1_000_000_000_000;

const MEDICATION = ESCALATION_LADDER;

function timing(overrides: Partial<PromptTiming> = {}): PromptTiming {
  return {
    state: "upcoming",
    scheduledTime: "08:00",
    windowStart: START,
    windowEnd: START + 60 * MIN,
    createdAt: START - 600 * MIN,
    firedSteps: [],
    ...overrides,
  };
}

describe("stepDueAt", () => {
  test("counts from the window start", () => {
    expect(stepDueAt(timing(), { offsetMinutes: 15 })).toBe(START + 15 * MIN);
  });

  test("counts from creation for an instance created after its window opened", () => {
    expect(stepDueAt(timing({ createdAt: START + 20 * MIN }), { offsetMinutes: 15 })).toBe(
      START + 35 * MIN,
    );
  });
});

describe("stepHeld", () => {
  test("holds a senior prompt while snoozed, not an alert", () => {
    const snoozed = timing({ snoozedUntil: START + 30 * MIN });
    expect(stepHeld(snoozed, MEDICATION[1]!, START + 20 * MIN)).toBe(true);
    expect(stepHeld(snoozed, MEDICATION[1]!, START + 30 * MIN)).toBe(false);
    expect(stepHeld(snoozed, MEDICATION[2]!, START + 20 * MIN)).toBe(false);
  });
});

describe("upcomingPromptTimes", () => {
  const DAY = 24 * 60 * MIN;

  test("lists the unfired prompt steps only, ascending", () => {
    expect(upcomingPromptTimes(timing(), MEDICATION, START - 60 * MIN, START + DAY)).toEqual([
      START,
      START + 15 * MIN,
    ]);
  });

  test("skips fired steps and instants at or before `from`", () => {
    const due = timing({ state: "due", firedSteps: [{ stepId: "prompt" }] });
    expect(upcomingPromptTimes(due, MEDICATION, START + 5 * MIN, START + DAY)).toEqual([
      START + 15 * MIN,
    ]);
    expect(upcomingPromptTimes(timing(), MEDICATION, START, START + DAY)).toEqual([
      START + 15 * MIN,
    ]);
  });

  test("leaves out instants after `to`", () => {
    expect(upcomingPromptTimes(timing(), MEDICATION, START - MIN, START + 10 * MIN)).toEqual([
      START,
    ]);
  });

  test("a snooze moves held prompts to its end, and they collapse into one", () => {
    const snoozed = timing({ state: "due", snoozedUntil: START + 40 * MIN });
    expect(upcomingPromptTimes(snoozed, MEDICATION, START + 5 * MIN, START + DAY)).toEqual([
      START + 40 * MIN,
    ]);
  });

  test("a prompt due after the snooze ends keeps its own time", () => {
    const snoozed = timing({
      state: "due",
      firedSteps: [{ stepId: "prompt" }],
      snoozedUntil: START + 10 * MIN,
    });
    expect(upcomingPromptTimes(snoozed, MEDICATION, START + 5 * MIN, START + DAY)).toEqual([
      START + 15 * MIN,
    ]);
  });

  test("nothing fires once the window has ended", () => {
    const short = timing({ windowEnd: START + 15 * MIN });
    expect(upcomingPromptTimes(short, MEDICATION, START - MIN, START + DAY)).toEqual([START]);
    const snoozedPastEnd = timing({ state: "due", snoozedUntil: START + 70 * MIN });
    expect(upcomingPromptTimes(snoozedPastEnd, MEDICATION, START + MIN, START + DAY)).toEqual([]);
  });

  test("anytime, done and missed instances never prompt", () => {
    for (const t of [
      timing({ scheduledTime: "anytime" }),
      timing({ state: "confirmed" }),
      timing({ state: "resolved" }),
      timing({ state: "missed" }),
    ]) {
      expect(upcomingPromptTimes(t, MEDICATION, START - MIN, START + DAY)).toEqual([]);
    }
  });

  test("escalated instances keep prompting", () => {
    const escalated = timing({ state: "escalated", firedSteps: [{ stepId: "prompt" }] });
    expect(upcomingPromptTimes(escalated, MEDICATION, START + MIN, START + DAY)).toEqual([
      START + 15 * MIN,
    ]);
  });
});

describe("escalationSteps", () => {
  type LadderInput = Pick<Doc<"tasks">, "type" | "times" | "highPriority" | "active">;

  function task(fields: Partial<LadderInput>): LadderInput {
    return { type: "routine", times: ["09:00"], active: true, highPriority: false, ...fields };
  }

  test("ladder ids and offsets are fixed", () => {
    expect(ESCALATION_LADDER.map((s) => [s.id, s.offsetMinutes, s.action])).toEqual([
      ["prompt", 0, "prompt_senior"],
      ["prompt_again", 15, "prompt_senior"],
      ["alert", 30, "alert_all_caregivers"],
    ]);
    expect(PROMPT_ONLY_LADDER.map((s) => s.id)).toEqual(["prompt"]);
  });

  test("a medication gets the full ladder whatever its high priority flag", () => {
    expect(escalationSteps(task({ type: "medication" }))).toBe(ESCALATION_LADDER);
  });

  test("a high priority task gets the full ladder, any other only the first prompt", () => {
    expect(escalationSteps(task({ highPriority: true }))).toBe(ESCALATION_LADDER);
    expect(escalationSteps(task({}))).toBe(PROMPT_ONLY_LADDER);
  });

  test("an inactive, missing or anytime task has no steps", () => {
    expect(escalationSteps(task({ type: "medication", active: false }))).toEqual([]);
    expect(escalationSteps(null)).toEqual([]);
    expect(escalationSteps(task({ times: [], highPriority: true }))).toEqual([]);
  });

  test("alertsCaregivers is false for an anytime task, even a high priority one", () => {
    expect(alertsCaregivers(task({ highPriority: true }))).toBe(true);
    expect(alertsCaregivers(task({ times: [], highPriority: true }))).toBe(false);
    expect(alertsCaregivers(task({ type: "medication" }))).toBe(true);
    expect(alertsCaregivers(task({}))).toBe(false);
  });
});
