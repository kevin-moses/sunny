import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  ACTIVITY_CAP_MS,
  CONTENT_MAX_BYTES,
  activityView,
  fitContent,
  nextCommand,
  sameContent,
} from "./liveActivity";
import type { ActivityView } from "./liveActivity";
import {
  INSTANCE_ID,
  MIN,
  SHOWER_STEPS,
  UPDATE_TOKEN,
  WINDOW_END,
  WINDOW_START,
  instanceDoc,
  livePhase,
  rowOf,
  showerTask,
  taskDoc,
} from "./liveActivityFixtures.helpers";
import type { ActivityContent, LiveActivityPhase } from "./validators";

const NOW = WINDOW_START + 5 * MIN;

const OUTBOX_ID = "kd7x1c3v5b7n9m2q4w6e8r0t1y3u5p7a" as Id<"notificationOutbox">;

const PILLS_CARD = {
  instanceId: INSTANCE_ID,
  step: 0,
  stepCount: 1,
  stepText: null,
  label: "Morning pills",
  sentence: "Take your morning pills.",
  detail: "the small white ones",
  startsAt: WINDOW_START,
  endsAt: WINDOW_END,
};

const PILLS: ActivityContent = { card: PILLS_CARD, nextSteps: [], closed: null };

function pillsView(
  instance: Parameters<typeof instanceDoc>[0] = {},
  now: number = NOW,
): ActivityView {
  return activityView(
    {
      subject: { instance: instanceDoc(instance), task: taskDoc() },
      row: null,
      phoneCanConfirm: true,
    },
    now,
  );
}

function bytes(content: ActivityContent): number {
  return new TextEncoder().encode(JSON.stringify(content)).length;
}

describe("activityView", () => {
  test.each(["due", "escalated"] as const)("a %s task inside its window is shown", (state) => {
    expect(pillsView({ state })).toEqual({
      kind: "show",
      content: PILLS,
      staleAt: WINDOW_END,
      relevance: 4_000_000_000 - WINDOW_START / 1000,
    });
  });

  test("a snoozed due task is still shown", () => {
    expect(pillsView({ snoozedUntil: NOW + 10 * MIN }).kind).toBe("show");
  });

  test("a task without a screen sentence or pill description shows nulls", () => {
    const { screenSentence: _sentence, pillDescription: _pills, ...task } = taskDoc();
    const view = activityView(
      { subject: { instance: instanceDoc(), task }, row: null, phoneCanConfirm: true },
      NOW,
    );
    expect(view.content.card).toMatchObject({ sentence: null, detail: null });
  });

  test.each(["confirmed", "resolved"] as const)(
    "a %s task ends as confirmed with the time it was done",
    (state) => {
      const confirmedAt = WINDOW_START + 3 * MIN;
      expect(pillsView({ state, confirmedAt })).toEqual({
        kind: "end",
        reason: "confirmed",
        content: { ...PILLS, closed: { kind: "done", at: confirmedAt } },
      });
    },
  );

  test("a missed task ends as window_closed at its window end", () => {
    expect(pillsView({ state: "missed" }, WINDOW_END + 2 * MIN)).toEqual({
      kind: "end",
      reason: "window_closed",
      content: { ...PILLS, closed: { kind: "over", at: WINDOW_END } },
    });
  });

  test("a due task whose window has ended before the tick ran ends as window_closed", () => {
    expect(pillsView({ state: "due" }, WINDOW_END)).toMatchObject({
      kind: "end",
      reason: "window_closed",
    });
    expect(pillsView({ state: "due" }, WINDOW_END - 1).kind).toBe("show");
  });

  test("an upcoming task and an anytime task get no activity", () => {
    expect(pillsView({ state: "upcoming" }, WINDOW_START - MIN)).toMatchObject({
      kind: "end",
      reason: "window_closed",
      content: { closed: { kind: "over", at: WINDOW_START - MIN } },
    });
    expect(pillsView({ scheduledTime: "anytime" })).toMatchObject({
      kind: "end",
      reason: "window_closed",
    });
  });

  test("a phone that can no longer confirm ends as device_revoked", () => {
    const view = activityView(
      { subject: { instance: instanceDoc(), task: taskDoc() }, row: null, phoneCanConfirm: false },
      NOW,
    );
    expect(view).toEqual({
      kind: "end",
      reason: "device_revoked",
      content: { ...PILLS, closed: { kind: "over", at: NOW } },
    });
  });

  test("a deleted instance ends as instance_gone with the content last shown", () => {
    const view = activityView(
      { subject: null, row: rowOf(livePhase(), PILLS), phoneCanConfirm: true },
      NOW,
    );
    expect(view).toEqual({
      kind: "end",
      reason: "instance_gone",
      content: { ...PILLS, closed: { kind: "over", at: NOW } },
    });
  });

  test("an ended row keeps its stored content and reason whatever the instance says", () => {
    const shown = { ...PILLS, closed: { kind: "done" as const, at: NOW } };
    const row = rowOf({ kind: "ended", at: NOW, reason: "confirmed" }, shown);
    const view = activityView(
      { subject: { instance: instanceDoc(), task: taskDoc() }, row, phoneCanConfirm: true },
      NOW + MIN,
    );
    expect(view).toEqual({ kind: "end", reason: "confirmed", content: shown });
  });

  describe("a window longer than the system's eight hours", () => {
    const longEnd = WINDOW_START + 12 * 60 * MIN;
    const acceptedAt = WINDOW_START + MIN;
    const capAt = acceptedAt + ACTIVITY_CAP_MS;
    const phases: LiveActivityPhase[] = [
      { kind: "starting", outboxId: OUTBOX_ID, since: acceptedAt },
      { kind: "started", acceptedAt, proof: "awaited" },
      livePhase(acceptedAt),
    ];

    function longView(phase: LiveActivityPhase | null, now: number): ActivityView {
      const subject = { instance: instanceDoc({ windowEnd: longEnd }), task: taskDoc() };
      const row = phase === null ? null : rowOf(phase, PILLS);
      return activityView({ subject, row, phoneCanConfirm: true }, now);
    }

    test("the cap is 7 hours 50 minutes", () => {
      expect(ACTIVITY_CAP_MS).toBe(470 * MIN);
    });

    test("a new activity goes stale at the cap, counted from now", () => {
      expect(longView(null, NOW)).toMatchObject({ kind: "show", staleAt: NOW + ACTIVITY_CAP_MS });
    });

    test.each(phases)("a $kind row is shown until the cap counted from its start", (phase) => {
      expect(longView(phase, capAt - 1)).toMatchObject({ kind: "show", staleAt: capAt });
    });

    test.each(phases)("a $kind row ends as expired at the cap", (phase) => {
      expect(longView(phase, capAt)).toMatchObject({
        kind: "end",
        reason: "expired",
        content: { closed: { kind: "over", at: capAt } },
      });
    });
  });

  test("a multi-step task shows its current step and carries the later steps", () => {
    const subject = { instance: instanceDoc({ currentStep: 1 }), task: showerTask() };
    const view = activityView({ subject, row: null, phoneCanConfirm: true }, NOW);
    expect(view.content).toEqual({
      card: {
        instanceId: INSTANCE_ID,
        step: 1,
        stepCount: 3,
        stepText: SHOWER_STEPS[1],
        label: "Shower",
        sentence: "Take your shower.",
        detail: null,
        startsAt: WINDOW_START,
        endsAt: WINDOW_END,
      },
      nextSteps: [SHOWER_STEPS[2]],
      closed: null,
    });
  });

  test("the last step carries no later steps", () => {
    const subject = { instance: instanceDoc({ currentStep: 2 }), task: showerTask() };
    const view = activityView({ subject, row: null, phoneCanConfirm: true }, NOW);
    expect(view.content.card.step).toBe(2);
    expect(view.content.nextSteps).toEqual([]);
  });

  test("an earlier window ranks above a later one", () => {
    const earlier = pillsView({ windowStart: WINDOW_START - 30 * MIN });
    const later = pillsView({ windowStart: WINDOW_START });
    expect(earlier.kind === "show" && later.kind === "show").toBe(true);
    if (earlier.kind !== "show" || later.kind !== "show") return;
    expect(earlier.relevance).toBeGreaterThan(later.relevance);
  });

  test("a checklist of fifty long steps is cut to fit and stays a prefix of the steps", () => {
    const steps = Array.from({ length: 50 }, (_, n) => `${n + 1} ${"x".repeat(196)}`);
    const subject = { instance: instanceDoc(), task: showerTask({ checklistItems: steps }) };
    const view = activityView({ subject, row: null, phoneCanConfirm: true }, NOW);
    expect(bytes(view.content)).toBeLessThanOrEqual(CONTENT_MAX_BYTES);
    expect(view.content.card).toMatchObject({ step: 0, stepCount: 50, stepText: steps[0] });
    expect(view.content.nextSteps.length).toBeGreaterThan(5);
    expect(view.content.nextSteps).toEqual(steps.slice(1, 1 + view.content.nextSteps.length));
  });
});

describe("fitContent", () => {
  const stepsOf = (count: number, text: string): ActivityContent => ({
    card: { ...PILLS_CARD, stepCount: count + 1, stepText: text },
    nextSteps: Array.from({ length: count }, () => text),
    closed: null,
  });

  test("content under the limit is returned unchanged", () => {
    const content = stepsOf(3, "Wash and rinse.");
    expect(fitContent(content)).toEqual(content);
  });

  test("later steps are dropped from the end until the content fits, and no more", () => {
    const content = stepsOf(40, "y".repeat(200));
    const fitted = fitContent(content);
    expect(bytes(fitted)).toBeLessThanOrEqual(CONTENT_MAX_BYTES);
    expect(fitted.card).toEqual(content.card);
    const oneMore = {
      ...fitted,
      nextSteps: content.nextSteps.slice(0, fitted.nextSteps.length + 1),
    };
    expect(bytes(oneMore)).toBeGreaterThan(CONTENT_MAX_BYTES);
  });

  test("the limit counts bytes, so accented text fits fewer steps", () => {
    const plain = fitContent(stepsOf(40, "e".repeat(100)));
    const accented = fitContent(stepsOf(40, "é".repeat(100)));
    expect(accented.nextSteps.length).toBeLessThan(plain.nextSteps.length);
    expect(bytes(accented)).toBeLessThanOrEqual(CONTENT_MAX_BYTES);
  });

  test("a card that is too large by itself keeps its text and loses every later step", () => {
    const content = stepsOf(2, "z".repeat(CONTENT_MAX_BYTES));
    expect(fitContent(content)).toEqual({ ...content, nextSteps: [] });
  });
});

describe("nextCommand", () => {
  const show: ActivityView = { kind: "show", content: PILLS, staleAt: WINDOW_END, relevance: 1 };
  const stepTwo: ActivityContent = {
    card: { ...PILLS_CARD, step: 1, stepCount: 3, stepText: "Wash and rinse." },
    nextSteps: ["Dry off and dress."],
    closed: null,
  };
  const end: ActivityView = {
    kind: "end",
    reason: "confirmed",
    content: { ...PILLS, closed: { kind: "done", at: NOW } },
  };
  const tokenless: LiveActivityPhase[] = [
    { kind: "starting", outboxId: OUTBOX_ID, since: WINDOW_START },
    { kind: "started", acceptedAt: WINDOW_START, proof: "awaited" },
    { kind: "started", acceptedAt: WINDOW_START, proof: "proven" },
    { kind: "ended", at: NOW, reason: "confirmed" },
  ];

  test.each(tokenless)("a $kind row has no token, so nothing is sent", (phase) => {
    expect(nextCommand(rowOf(phase, PILLS), end)).toEqual({ kind: "none" });
    expect(nextCommand(rowOf(phase, PILLS), { ...show, content: stepTwo })).toEqual({
      kind: "none",
    });
  });

  test("a live row that already shows the view sends nothing", () => {
    expect(nextCommand(rowOf(livePhase(), PILLS), show)).toEqual({ kind: "none" });
  });

  test("a live row whose content differs gets an update with the view's stale time", () => {
    expect(nextCommand(rowOf(livePhase(), PILLS), { ...show, content: stepTwo })).toEqual({
      kind: "update",
      token: UPDATE_TOKEN,
      content: stepTwo,
      staleAt: WINDOW_END,
    });
  });

  test("an edited label is a difference", () => {
    const edited = { ...PILLS, card: { ...PILLS_CARD, label: "Morning tablets" } };
    expect(nextCommand(rowOf(livePhase(), PILLS), { ...show, content: edited }).kind).toBe(
      "update",
    );
  });

  test("a live row whose view is an end gets the end with its reason", () => {
    expect(nextCommand(rowOf(livePhase(), PILLS), end)).toEqual({
      kind: "end",
      token: UPDATE_TOKEN,
      content: end.content,
      reason: "confirmed",
    });
  });

  test("content is compared by value, whatever order its keys are stored in", () => {
    const reordered: ActivityContent = {
      closed: null,
      nextSteps: [],
      card: {
        endsAt: WINDOW_END,
        startsAt: WINDOW_START,
        detail: "the small white ones",
        sentence: "Take your morning pills.",
        label: "Morning pills",
        stepText: null,
        stepCount: 1,
        step: 0,
        instanceId: INSTANCE_ID,
      },
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(PILLS));
    expect(sameContent(reordered, PILLS)).toBe(true);
    expect(nextCommand(rowOf(livePhase(), reordered), show)).toEqual({ kind: "none" });
  });
});
