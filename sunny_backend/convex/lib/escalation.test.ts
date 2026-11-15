import { describe, expect, test } from "vitest";
import { stepDueAt, stepHeld, upcomingPromptTimes } from "./escalation";
import type { PromptTiming } from "./escalation";
import type { EscalationStep } from "./validators";

const MIN = 60_000;
const START = 1_000_000_000_000;

function step(id: string, offsetMinutes: number, overrides: Partial<EscalationStep> = {}) {
  return {
    id,
    offsetMinutes,
    action: "prompt_senior",
    skipIfClaimed: false,
    ...overrides,
  } as const;
}

const MEDICATION: EscalationStep[] = [
  step("p0", 0),
  step("p15", 15),
  step("a30", 30, { action: "alert_on_call" }),
  step("a45", 45, { action: "alert_all_caregivers", skipIfClaimed: true }),
];

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

  test("holds a skipIfClaimed step once claimed", () => {
    expect(stepHeld(timing({ claimedBy: "pat" }), MEDICATION[3]!, START)).toBe(true);
    expect(stepHeld(timing({ claimedBy: null }), MEDICATION[3]!, START)).toBe(false);
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
    const due = timing({ state: "due", firedSteps: [{ stepId: "p0" }] });
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
      firedSteps: [{ stepId: "p0" }],
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

  test("a claimed instance drops skipIfClaimed prompts only", () => {
    const steps = [step("p0", 0), step("p15", 15, { skipIfClaimed: true })];
    const claimed = timing({ state: "due", claimedBy: "pat" });
    expect(upcomingPromptTimes(claimed, steps, START - MIN, START + DAY)).toEqual([START]);
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
    const escalated = timing({ state: "escalated", firedSteps: [{ stepId: "p0" }] });
    expect(upcomingPromptTimes(escalated, MEDICATION, START + MIN, START + DAY)).toEqual([
      START + 15 * MIN,
    ]);
  });
});
