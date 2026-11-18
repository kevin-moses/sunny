import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DONE_INSTANCE_HEADER, DONE_STEP_HEADER } from "./deviceApi";
import { PRESS_TAKEN_BACK, SENIOR_UNDO_MS } from "./lib/confirmRule";
import type { DeviceState } from "./lib/deviceState";
import {
  OTHER_STEP,
  STEP_NOT_VALID,
  hasStepAfter,
  seniorCanUndoStep,
  steppedBack,
  taskStep,
} from "./lib/taskSteps";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.helpers.ts"]);

const STEPS = ["Put on your coat", "Take your keys", "Lock the door"];

const AGENT_KEY = "steps-agent-key";

let savedKey: string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  savedKey = process.env.SUNNY_AGENT_KEY;
  process.env.SUNNY_AGENT_KEY = AGENT_KEY;
});

afterEach(() => {
  vi.useRealTimers();
  if (savedKey === undefined) delete process.env.SUNNY_AGENT_KEY;
  else process.env.SUNNY_AGENT_KEY = savedKey;
});

function at(iso: string): number {
  vi.setSystemTime(new Date(iso));
  return Date.parse(iso);
}

function makeBackend() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  workpoolTest.register(t, "deliveryPool");
  return t;
}

type TestConvex = ReturnType<typeof makeBackend>;

interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  instanceId: Id<"taskInstances">;
}

function pressId(n: number): string {
  return `press-${String(n).padStart(12, "0")}`;
}

async function setup(steps: string[] = STEPS): Promise<Fixture> {
  at("2027-03-14T11:00:00Z");
  const t = makeBackend();
  const pat = t.withIdentity({ subject: "pat" });
  const householdId = await pat.mutation(api.households.create, {
    seniorPreferredName: "Mom",
    timezone: "America/New_York",
    caregiverDisplayName: "Pat",
  });
  for (const [userId, grants] of [
    ["phone", "senior_phone"],
    ["display", "home_display"],
  ] as const) {
    const { code } = await pat.mutation(api.households.createJoinCode, { householdId, grants });
    await t.mutation(internal.households.pairDevice, { code, userId });
  }
  await pat.mutation(api.tasks.create, {
    householdId,
    type: "checklist",
    title: "Getting ready to go out",
    displayLabel: "Getting ready to go out",
    checklistItems: steps,
    times: ["08:00"],
    highPriority: true,
  });
  const rows = await t.run(async (ctx) => await ctx.db.query("taskInstances").collect());
  const f = { t, householdId, instanceId: rows[0]!._id };
  await tick(f, "2027-03-14T12:00:00Z");
  return f;
}

async function tick(f: Fixture, iso: string): Promise<void> {
  await f.t.mutation(internal.scheduler.tickHousehold, {
    householdId: f.householdId,
    now: Date.parse(iso),
  });
}

async function row(f: Fixture): Promise<Doc<"taskInstances">> {
  return (await f.t.run(async (ctx) => await ctx.db.get(f.instanceId)))!;
}

async function press(f: Fixture, iso: string, id: number, agoMs = 0, subject = "phone") {
  at(iso);
  return await f.t.withIdentity({ subject }).mutation(api.instances.confirmPressedTask, {
    instanceId: f.instanceId,
    via: "phone_app",
    pressedAgoMs: agoMs,
    pressId: pressId(id),
  });
}

async function undo(f: Fixture, iso: string, id: number, subject = "phone") {
  at(iso);
  return await f.t.withIdentity({ subject }).mutation(api.instances.undoPressedTask, {
    instanceId: f.instanceId,
    pressId: pressId(id),
  });
}

async function audits(f: Fixture, action: string): Promise<Doc<"auditLog">[]> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
  return rows.filter((r) => r.entityId === f.instanceId && r.action === action);
}

async function prompts(f: Fixture): Promise<Doc<"notificationOutbox">[]> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("notificationOutbox").collect());
  return rows.filter((r) => r.taskInstanceId === f.instanceId);
}

describe("taskSteps rules", () => {
  test("a task needs two or more items to have steps, and the stored step is clamped", () => {
    expect(taskStep([], 0)).toBeNull();
    expect(taskStep(["Only one"], 0)).toBeNull();
    expect(taskStep(STEPS, undefined)).toEqual({ index: 0, count: 3, text: "Put on your coat" });
    expect(taskStep(STEPS, 9)).toEqual({ index: 2, count: 3, text: "Lock the door" });
    expect(taskStep(STEPS, -2)?.index).toBe(0);
    expect(hasStepAfter(taskStep(STEPS, 1))).toBe(true);
    expect(hasStepAfter(taskStep(STEPS, 2))).toBe(false);
    expect(hasStepAfter(null)).toBe(false);
  });

  test("stepping back pops the latest press and returns to the step it was made on", () => {
    const presses = [
      { step: 0, at: 1, by: "phone", pressId: pressId(1) },
      { step: 1, at: 2, by: "phone", pressId: pressId(2) },
    ];
    expect(steppedBack({ currentStep: 2, stepPresses: presses })).toEqual({
      currentStep: 1,
      stepPresses: [presses[0]],
    });
    expect(steppedBack({ currentStep: undefined, stepPresses: undefined })).toEqual({
      currentStep: undefined,
      stepPresses: [],
    });
  });

  test("only the latest step press, by the same device, inside the undo window, can be undone", () => {
    const instance = {
      state: "due" as const,
      currentStep: 1,
      stepPresses: [{ step: 0, at: 1000, by: "phone", pressId: pressId(1) }],
    };
    expect(seniorCanUndoStep(instance, "phone", pressId(1), 1000 + SENIOR_UNDO_MS)).toBe(true);
    expect(seniorCanUndoStep(instance, "phone", pressId(1), 1001 + SENIOR_UNDO_MS)).toBe(false);
    expect(seniorCanUndoStep(instance, "display", pressId(1), 1000)).toBe(false);
    expect(seniorCanUndoStep(instance, "phone", pressId(2), 1000)).toBe(false);
    expect(seniorCanUndoStep({ ...instance, state: "confirmed" }, "phone", pressId(1), 1000)).toBe(
      false,
    );
    expect(seniorCanUndoStep({ ...instance, stepPresses: [] }, "phone", pressId(1), 1000)).toBe(
      false,
    );
  });
});

describe("Done on a multi-step task", () => {
  test("advances one step per press and confirms only on the last step", async () => {
    const f = await setup();
    const first = await press(f, "2027-03-14T12:01:00Z", 1);
    expect(first.status).toBe("advanced");
    expect(await row(f)).toMatchObject({ state: "due", currentStep: 1 });
    const second = await press(f, "2027-03-14T12:02:00Z", 2);
    expect(second.status).toBe("advanced");
    expect(await row(f)).toMatchObject({ state: "due", currentStep: 2 });
    const last = await press(f, "2027-03-14T12:03:00Z", 3);
    expect(last.status).toBe("confirmed");
    const done = await row(f);
    expect(done).toMatchObject({ state: "confirmed", currentStep: 2, confirmedVia: "phone_app" });
    expect(done.confirmPressIds).toEqual([pressId(3)]);
    expect(done.stepPresses?.map((p) => p.pressId)).toEqual([pressId(1), pressId(2)]);
    const steps = await audits(f, "step");
    expect(steps.map((a) => [a.detail.fromStep, a.detail.toStep])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(steps[0]!.detail.pressId).toBe(pressId(1));
  });

  test("a replayed press with the same press id never advances twice", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    const replay = await press(f, "2027-03-14T12:04:00Z", 1, 3 * 60_000);
    expect(replay.status).toBe("advanced");
    const after = await row(f);
    expect(after.currentStep).toBe(1);
    expect(after.stepPresses).toHaveLength(1);
    expect(await audits(f, "step")).toHaveLength(1);
  });

  test("a replay of an earlier step's press after the task was confirmed changes nothing", async () => {
    const f = await setup(["Coat", "Keys"]);
    await press(f, "2027-03-14T12:01:00Z", 1);
    await press(f, "2027-03-14T12:02:00Z", 2);
    const before = await row(f);
    expect(before.state).toBe("confirmed");
    await press(f, "2027-03-14T12:05:00Z", 1, 4 * 60_000);
    expect(await row(f)).toEqual(before);
  });

  test("the home display's live Done (no press id) advances the step too", async () => {
    const f = await setup();
    at("2027-03-14T12:01:00Z");
    const result = await f.t
      .withIdentity({ subject: "display" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: f.instanceId, via: "button" });
    expect(result).toMatchObject({ state: "due", currentStep: 1 });
    expect(result.stepPresses).toEqual([
      { step: 0, at: Date.parse("2027-03-14T12:01:00Z"), by: "display" },
    ]);
  });

  test("a caregiver's Mark done resolves the whole task from any step", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    at("2027-03-14T12:02:00Z");
    const resolved = await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.confirmTaskInstance, { instanceId: f.instanceId, via: "caregiver" });
    expect(resolved).toMatchObject({ state: "resolved", currentStep: 1 });
  });

  test("a single-item checklist is confirmed by the first Done, as before", async () => {
    const f = await setup(["Only one"]);
    expect((await press(f, "2027-03-14T12:01:00Z", 1)).status).toBe("confirmed");
    expect((await row(f)).currentStep).toBeUndefined();
  });
});

describe("senior Undo with steps", () => {
  test("Undo of an advance goes back one step and a replay of that press is refused", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    await press(f, "2027-03-14T12:02:00Z", 2);
    const undone = await undo(f, "2027-03-14T12:02:20Z", 2);
    expect(undone.status).toBe("undone");
    const back = await row(f);
    expect(back).toMatchObject({ state: "due", currentStep: 1 });
    expect(back.stepPresses?.map((p) => p.pressId)).toEqual([pressId(1)]);
    expect(back.takenBackPressIds).toEqual([pressId(2)]);
    const replay = await press(f, "2027-03-14T12:03:00Z", 2, 60_000);
    expect(replay).toEqual({ status: "rejected", reason: PRESS_TAKEN_BACK });
    expect((await row(f)).currentStep).toBe(1);
    expect((await audits(f, "step")).at(-1)?.detail).toMatchObject({
      fromStep: 2,
      toStep: 1,
      undo: true,
      takenBackPressIds: [pressId(2)],
    });
  });

  test("a new press after the Undo advances again", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    await undo(f, "2027-03-14T12:01:10Z", 1);
    expect((await row(f)).currentStep).toBe(0);
    expect((await press(f, "2027-03-14T12:01:30Z", 4)).status).toBe("advanced");
    expect((await row(f)).currentStep).toBe(1);
  });

  test("a step Undo leaves another device's earlier press to be judged by its step", async () => {
    const f = await setup();
    const token = await deviceToken(f);
    await press(f, "2027-03-14T12:01:10Z", 1);
    await undo(f, "2027-03-14T12:01:20Z", 1);
    const back = await row(f);
    expect(back.currentStep).toBe(0);
    expect(back.confirmTakenBackAt).toBeUndefined();
    at("2027-03-14T12:01:30Z");
    const res = await postConfirm(f, token, { pressedAgoMs: 30_000, step: 0 });
    expect(((await res.json()) as { status: string }).status).toBe("advanced");
    expect((await row(f)).currentStep).toBe(1);
  });

  test("Undo after the last step's confirm reopens the task on its last step", async () => {
    const f = await setup(["Coat", "Keys"]);
    await press(f, "2027-03-14T12:01:00Z", 1);
    await press(f, "2027-03-14T12:02:00Z", 2);
    expect((await undo(f, "2027-03-14T12:02:10Z", 2)).status).toBe("undone");
    expect(await row(f)).toMatchObject({ state: "due", currentStep: 1 });
  });

  test("refuses an Undo of an older step, another device's step or one past the window", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    await press(f, "2027-03-14T12:01:20Z", 2);
    expect((await undo(f, "2027-03-14T12:01:30Z", 1)).status).toBe("too_late");
    expect((await undo(f, "2027-03-14T12:01:30Z", 2, "display")).status).toBe("too_late");
    expect((await undo(f, "2027-03-14T12:02:30Z", 2)).status).toBe("too_late");
    expect((await row(f)).currentStep).toBe(2);
    expect(await audits(f, "undo_not_applied")).toHaveLength(3);
  });
});

describe("caregiver reopen of a multi-step task", () => {
  test("reopens a confirmed task on its last step", async () => {
    const f = await setup(["Coat", "Keys"]);
    await press(f, "2027-03-14T12:01:00Z", 1);
    await press(f, "2027-03-14T12:02:00Z", 2);
    at("2027-03-14T12:10:00Z");
    const reopened = await f.t
      .withIdentity({ subject: "pat" })
      .mutation(api.instances.reopenTaskInstance, { instanceId: f.instanceId });
    expect(reopened).toMatchObject({ state: "due", currentStep: 1 });
    expect((await press(f, "2027-03-14T12:11:00Z", 3)).status).toBe("confirmed");
  });
});

describe("the ladder while steps are left", () => {
  test("repeat prompts read the current step and caregivers are still alerted", async () => {
    const f = await setup();
    const opening = (await prompts(f)).filter((p) => p.kind === "senior_prompt");
    expect(opening[0]!.body).toContain("Step 1 of 3: Put on your coat.");
    await press(f, "2027-03-14T12:05:00Z", 1);
    await tick(f, "2027-03-14T12:15:00Z");
    const repeat = (await prompts(f)).filter(
      (p) => p.kind === "senior_prompt" && p._creationTime > opening[0]!._creationTime,
    );
    expect(repeat.map((p) => p.body.endsWith("Step 2 of 3: Take your keys."))).toContain(true);
    await tick(f, "2027-03-14T12:30:00Z");
    expect((await row(f)).state).toBe("escalated");
    expect((await prompts(f)).some((p) => p.kind === "caregiver_alert")).toBe(true);
  });
});

describe("what the surfaces read", () => {
  test("the day view gives the step, and the press ids only to the device that pressed", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    const taskOf = async (subject: string) =>
      (
        await f.t
          .withIdentity({ subject })
          .query(api.calendar.dayView, { householdId: f.householdId })
      ).tasks[0]!;
    const phone = await taskOf("phone");
    expect(phone.step).toEqual({ index: 1, count: 3, text: "Take your keys" });
    expect(phone.stepPressIds).toEqual([pressId(1)]);
    expect((await taskOf("display")).stepPressIds).toEqual([]);
    expect((await taskOf("pat")).step?.index).toBe(1);
    expect((await taskOf("pat")).stepPressIds).toEqual([]);
  });

  test("the device state and its cue carry the step, and both versions change with it", async () => {
    const f = await setup();
    const read = async (): Promise<DeviceState> =>
      await f.t.withIdentity({ subject: "display" }).query(api.deviceApi.state, {});
    at("2027-03-14T12:00:30Z");
    const before = await read();
    expect(before.now.task?.step).toEqual({ index: 0, count: 3, text: "Put on your coat" });
    await press(f, "2027-03-14T12:01:00Z", 1);
    at("2027-03-14T12:01:00Z");
    const after = await read();
    expect(after.now.task?.step).toEqual({ index: 1, count: 3, text: "Take your keys" });
    expect(after.now.task?.steps).toEqual(STEPS);
    expect(after.cues[0]!.speech).toMatch(/Step 2 of 3: Take your keys\.$/);
    expect(after.displayVersion).not.toBe(before.displayVersion);
    expect(after.version).not.toBe(before.version);
    expect(after.done?.instanceId).toBe(f.instanceId);
  });

  test("the voice agent's confirm advances and returns the next step", async () => {
    const f = await setup();
    at("2027-03-14T12:01:00Z");
    const result = await f.t.mutation(api.agent.confirmDueTask, {
      agentKey: AGENT_KEY,
      householdId: f.householdId,
    });
    expect(result).toMatchObject({
      status: "advanced",
      state: "due",
      step: { index: 1, count: 3, text: "Take your keys" },
    });
    expect((await row(f)).currentStep).toBe(1);
  });
});

describe("the device API with steps", () => {
  async function token(f: Fixture): Promise<string> {
    return (await f.t.withIdentity({ subject: "display" }).action(api.deviceApi.issueToken, {}))
      .deviceToken;
  }

  test("POST /device/confirm reports an advance, and the frame repaints on the new step", async () => {
    const f = await setup();
    const bearer = { Authorization: `Bearer ${await token(f)}` };
    at("2027-03-14T12:00:30Z");
    const frame = async () =>
      await f.t.fetch("/device/frame?page=now&format=png", { headers: bearer });
    const first = await frame();
    expect(first.status).toBe(200);
    expect(first.headers.get(DONE_INSTANCE_HEADER)).toBe(f.instanceId);
    const res = await f.t.fetch("/device/confirm", {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: f.instanceId, via: "button", pressedAgoMs: 0 }),
    });
    const body = (await res.json()) as { status: string; state: DeviceState };
    expect(body.status).toBe("advanced");
    expect(body.state.now.task?.step?.index).toBe(1);
    const repainted = await frame();
    expect(repainted.headers.get("ETag")).not.toBe(first.headers.get("ETag"));
    expect(repainted.headers.get(DONE_INSTANCE_HEADER)).toBe(f.instanceId);
  });
});

async function stepPress(
  f: Fixture,
  iso: string,
  id: number,
  step: number,
  agoMs = 0,
  subject = "phone",
) {
  at(iso);
  return await f.t.withIdentity({ subject }).mutation(api.instances.confirmPressedTask, {
    instanceId: f.instanceId,
    via: "phone_app",
    pressedAgoMs: agoMs,
    pressId: pressId(id),
    step,
  });
}

async function deviceToken(f: Fixture): Promise<string> {
  return (await f.t.withIdentity({ subject: "display" }).action(api.deviceApi.issueToken, {}))
    .deviceToken;
}

async function postConfirm(f: Fixture, token: string, body: Record<string, unknown>) {
  return await f.t.fetch("/device/confirm", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ instanceId: f.instanceId, via: "button", pressedAgoMs: 0, ...body }),
  });
}

describe("advance and Undo use the same not-done rule", () => {
  test("a press and its Undo replayed after the window closed both apply", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T13:01:00Z");
    expect((await row(f)).state).toBe("missed");
    const replayed = await press(f, "2027-03-14T13:10:00Z", 1, 40 * 60_000);
    expect(replayed.status).toBe("advanced");
    expect(await row(f)).toMatchObject({ state: "missed", currentStep: 1 });
    at("2027-03-14T13:10:01Z");
    const undone = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.undoPressedTask, {
        instanceId: f.instanceId,
        pressId: pressId(1),
        undoneAgoMs: 40 * 60_000 - 20_000,
      });
    expect(undone.status).toBe("undone");
    expect(await row(f)).toMatchObject({
      state: "missed",
      currentStep: 0,
      takenBackPressIds: [pressId(1)],
    });
    expect(await audits(f, "undo_not_applied")).toHaveLength(0);
  });

  test("the voice agent's confirm advances a missed multi-step task", async () => {
    const f = await setup();
    await tick(f, "2027-03-14T13:01:00Z");
    at("2027-03-14T13:05:00Z");
    const result = await f.t.mutation(api.agent.confirmDueTask, {
      agentKey: AGENT_KEY,
      householdId: f.householdId,
      label: "getting ready",
    });
    expect(result).toMatchObject({
      status: "advanced",
      state: "missed",
      step: { index: 1, count: 3, text: "Take your keys" },
    });
    expect(await row(f)).toMatchObject({ state: "missed", currentStep: 1 });
  });
});

describe("every press names its step", () => {
  test("a double POST for the same step advances once and records the second", async () => {
    const f = await setup();
    const token = await deviceToken(f);
    at("2027-03-14T12:01:00Z");
    const first = await postConfirm(f, token, { step: 0 });
    const second = await postConfirm(f, token, { step: 0 });
    expect(((await first.json()) as { status: string }).status).toBe("advanced");
    const body = (await second.json()) as { status: string; state: DeviceState };
    expect(body.status).toBe("advanced");
    expect(body.state.done?.step).toBe(1);
    expect(second.headers.get(DONE_STEP_HEADER)).toBe("1");
    expect(await row(f)).toMatchObject({ state: "due", currentStep: 1 });
    expect(await audits(f, "step")).toHaveLength(1);
    const ignored = await audits(f, "press_not_applied");
    expect(ignored.map((a) => a.detail)).toEqual([
      expect.objectContaining({
        reason: OTHER_STEP,
        pressedStep: 0,
        currentStep: 1,
        via: "button",
        transport: "device_api",
      }),
    ]);
  });

  test("a firmware replay of a POST that already landed advances once", async () => {
    const f = await setup();
    const token = await deviceToken(f);
    at("2027-03-14T12:01:00Z");
    await postConfirm(f, token, { step: 0 });
    at("2027-03-14T12:03:00Z");
    const replay = await postConfirm(f, token, { step: 0, pressedAgoMs: 120_000 });
    expect(((await replay.json()) as { status: string }).status).toBe("advanced");
    const after = await row(f);
    expect(after).toMatchObject({ state: "due", currentStep: 1 });
    expect(after.stepPresses).toHaveLength(1);
  });

  test("the display and an offline phone both pressing step 1 advance once", async () => {
    const f = await setup();
    at("2027-03-14T12:01:00Z");
    await f.t.withIdentity({ subject: "display" }).mutation(api.instances.confirmTaskInstance, {
      instanceId: f.instanceId,
      via: "button",
      step: 0,
    });
    const phone = await stepPress(f, "2027-03-14T12:02:00Z", 1, 0, 60_000);
    expect(phone.status).toBe("advanced");
    const after = await row(f);
    expect(after).toMatchObject({ state: "due", currentStep: 1 });
    expect(after.stepPresses?.map((p) => p.by)).toEqual(["display"]);
  });

  test("a stale press for an earlier step never confirms a task on its last step", async () => {
    const f = await setup();
    await stepPress(f, "2027-03-14T12:01:00Z", 1, 0);
    await stepPress(f, "2027-03-14T12:02:00Z", 2, 1);
    expect((await row(f)).currentStep).toBe(2);
    const stale = await stepPress(f, "2027-03-14T12:03:00Z", 3, 0, 120_000, "display");
    expect(stale.status).toBe("advanced");
    expect(await row(f)).toMatchObject({ state: "due", currentStep: 2 });
    expect((await stepPress(f, "2027-03-14T12:04:00Z", 4, 2)).status).toBe("confirmed");
  });

  test("voice names the step it read, and a stale one marks nothing and says the current step", async () => {
    const f = await setup();
    const voice = async (step: number) =>
      await f.t.mutation(api.agent.confirmDueTask, {
        agentKey: AGENT_KEY,
        householdId: f.householdId,
        step,
      });
    at("2027-03-14T12:01:00Z");
    expect(await voice(0)).toMatchObject({ status: "advanced", step: { index: 1 } });
    expect(await voice(0)).toMatchObject({
      status: "other_step",
      state: "due",
      step: { index: 1, text: "Take your keys" },
    });
    expect((await row(f)).currentStep).toBe(1);
    expect((await audits(f, "press_not_applied")).at(-1)?.detail).toMatchObject({
      reason: OTHER_STEP,
      via: "voice",
    });
  });

  test("voice with a step a task cannot have is an error, not a task that is not due yet", async () => {
    const f = await setup();
    at("2027-03-14T12:01:00Z");
    await expect(
      f.t.mutation(api.agent.confirmDueTask, {
        agentKey: AGENT_KEY,
        householdId: f.householdId,
        step: 99,
      }),
    ).rejects.toMatchObject({ data: { code: "invalid", message: STEP_NOT_VALID } });
    expect((await row(f)).currentStep).toBeUndefined();
  });

  test("a press without a step keeps advancing as before", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    await press(f, "2027-03-14T12:02:00Z", 2);
    expect((await row(f)).currentStep).toBe(2);
  });

  test("a step a task cannot have is refused", async () => {
    const f = await setup();
    expect(await stepPress(f, "2027-03-14T12:01:00Z", 1, 1.5)).toMatchObject({
      status: "rejected",
    });
    const res = await postConfirm(f, await deviceToken(f), { step: -1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "step must be a whole number from 0 to 49",
    );
    expect((await row(f)).currentStep).toBeUndefined();
  });

  test("frames and the state carry the shown step on 200 and 304", async () => {
    const f = await setup();
    const bearer = { Authorization: `Bearer ${await deviceToken(f)}` };
    at("2027-03-14T12:00:30Z");
    const frame = await f.t.fetch("/device/frame?page=now&format=packed", { headers: bearer });
    expect(frame.headers.get(DONE_STEP_HEADER)).toBe("0");
    const cached = await f.t.fetch("/device/frame?page=now&format=packed", {
      headers: { ...bearer, "If-None-Match": frame.headers.get("ETag")! },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get(DONE_STEP_HEADER)).toBe("0");
    await stepPress(f, "2027-03-14T12:01:00Z", 1, 0);
    const state = await f.t.fetch("/device/state", { headers: bearer });
    expect(state.headers.get(DONE_INSTANCE_HEADER)).toBe(f.instanceId);
    expect(state.headers.get(DONE_STEP_HEADER)).toBe("1");
    const stateCached = await f.t.fetch("/device/state", {
      headers: { ...bearer, "If-None-Match": state.headers.get("ETag")! },
    });
    expect(stateCached.status).toBe(304);
    expect(stateCached.headers.get(DONE_STEP_HEADER)).toBe("1");
  });
});

describe("a caregiver changing the steps", () => {
  async function changeSteps(f: Fixture, checklistItems: string[], iso: string): Promise<void> {
    const taskId = (await row(f)).taskId;
    at(iso);
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId,
      checklistItems,
    });
  }

  test("restarts today's instance in progress at step 1 and takes back its presses", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    await press(f, "2027-03-14T12:02:00Z", 2);
    await changeSteps(f, ["Coat", "Keys", "Phone", "Door"], "2027-03-14T12:10:00Z");
    const restarted = await row(f);
    expect(restarted).toMatchObject({ state: "due", currentStep: 0 });
    expect(restarted.stepPresses).toBeUndefined();
    expect(restarted.takenBackPressIds).toEqual([pressId(1), pressId(2)]);
    expect((await audits(f, "step")).at(-1)?.detail).toMatchObject({
      fromStep: 2,
      toStep: 0,
      restart: true,
      reason: "steps_changed",
    });
    const replay = await press(f, "2027-03-14T12:11:00Z", 2, 9 * 60_000);
    expect(replay).toEqual({ status: "rejected", reason: PRESS_TAKEN_BACK });
    expect((await press(f, "2027-03-14T12:12:00Z", 3)).status).toBe("advanced");
    expect((await row(f)).currentStep).toBe(1);
  });

  test("leaves an instance that has not started, or is done, as it is", async () => {
    const f = await setup(["Coat", "Keys"]);
    await changeSteps(f, ["Coat", "Keys", "Door"], "2027-03-14T12:10:00Z");
    expect(await audits(f, "step")).toHaveLength(0);
    await press(f, "2027-03-14T12:11:00Z", 1);
    await press(f, "2027-03-14T12:12:00Z", 2);
    await press(f, "2027-03-14T12:13:00Z", 3);
    const done = await row(f);
    expect(done.state).toBe("confirmed");
    await changeSteps(f, ["Coat"], "2027-03-14T12:14:00Z");
    expect(await row(f)).toEqual(done);
  });

  test("other changes to the task keep the step", async () => {
    const f = await setup();
    await press(f, "2027-03-14T12:01:00Z", 1);
    at("2027-03-14T12:05:00Z");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.tasks.update, {
      householdId: f.householdId,
      taskId: (await row(f)).taskId,
      checklistItems: STEPS,
      displayLabel: "Going out",
    });
    expect((await row(f)).currentStep).toBe(1);
  });
});

describe("a step advance and a snooze", () => {
  test("clears the snooze, so the ladder resumes and the next prompt reads the new step", async () => {
    const f = await setup();
    at("2027-03-14T12:05:00Z");
    await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.instances.snoozeTaskInstance, { instanceId: f.instanceId });
    expect((await row(f)).snoozedUntil).toBe(Date.parse("2027-03-14T12:20:00Z"));
    await press(f, "2027-03-14T12:06:00Z", 1);
    expect((await row(f)).snoozedUntil).toBeUndefined();
    expect((await audits(f, "step")).at(-1)?.detail).toMatchObject({
      fromStep: 0,
      toStep: 1,
      clearedSnoozedUntil: Date.parse("2027-03-14T12:20:00Z"),
    });
    const state = await f.t.withIdentity({ subject: "display" }).query(api.deviceApi.state, {});
    expect(state.cues[0]).toMatchObject({ snoozed: false, snoozedUntil: null, cueableNow: true });
    const before = (await prompts(f)).length;
    await tick(f, "2027-03-14T12:15:00Z");
    const repeat = (await prompts(f)).slice(before).filter((p) => p.kind === "senior_prompt");
    expect(repeat.length).toBeGreaterThan(0);
    for (const prompt of repeat) expect(prompt.body).toMatch(/Step 2 of 3: Take your keys\.$/);
  });
});
