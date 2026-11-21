import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  alertMessage,
  backgroundRefreshMessage,
  buildHeaders,
  liveActivityEndMessage,
  liveActivityStartMessage,
  liveActivityUpdateMessage,
  pushStyle,
  widgetReloadMessage,
} from "./apnsPayload";
import type { ApnsConfig } from "./apnsPayload";
import { RECEIPT_MS, activityView, nextCommand } from "./liveActivity";
import type {
  ActivityAttributes,
  ActivityCommand,
  ActivitySubject,
  ActivityView,
} from "./liveActivity";
import {
  ACTIVITY_KEY,
  INSTANCE_ID,
  MIN,
  PHONE,
  PHONE_USER_ID,
  WINDOW_START,
  instanceDoc,
  livePhase,
  rowOf,
  showerTask,
  taskDoc,
} from "./liveActivityFixtures.helpers";
import type { ApnsMessage } from "./validators";

const GOLDENS = new URL("./liveActivityGoldens/", import.meta.url);

const CONFIG: ApnsConfig = {
  keyId: "KEYID12345",
  teamId: "TEAMID1234",
  keyPem: "",
  bundleId: "com.kmsunny.sunny",
  environment: "production",
};

const PILLS_PROMPT = "It's 8 o'clock. Time for your morning pills, the small white ones.";

const SHOWER_PROMPT = "Time for your shower. Step 1 of 3: Turn on the water.";

const ACCEPTED_AT = WINDOW_START + 2_000;

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function shown(view: ActivityView): Extract<ActivityView, { kind: "show" }> {
  if (view.kind !== "show") throw new Error("the fixture must be a task that is shown");
  return view;
}

function updateOf(made: ActivityCommand): Extract<ActivityCommand, { kind: "update" }> {
  if (made.kind !== "update") throw new Error("the fixture must produce an update");
  return made;
}

function endOf(made: ActivityCommand): Extract<ActivityCommand, { kind: "end" }> {
  if (made.kind !== "end") throw new Error("the fixture must produce an end");
  return made;
}

function attributes(): ActivityAttributes {
  return {
    activityKey: ACTIVITY_KEY,
    instanceId: INSTANCE_ID,
    receiptMs: RECEIPT_MS,
    timeZone: "America/New_York",
  };
}

const pills: ActivitySubject = { instance: instanceDoc(), task: taskDoc() };

const shower: ActivitySubject = { instance: instanceDoc(), task: showerTask() };

const pillsShown = shown(activityView({ subject: pills, row: null, phone: PHONE }, WINDOW_START));

const showerShown = shown(
  activityView({ subject: shower, row: null, phone: PHONE }, WINDOW_START + 6 * MIN),
);

function fromLive(subject: ActivitySubject, was: ActivityView, now: number): ActivityCommand {
  const row = rowOf(livePhase(ACCEPTED_AT), was.content);
  return nextCommand(row, activityView({ subject, row, phone: PHONE }, now));
}

const CASES: Record<string, ApnsMessage> = {
  "start.json": liveActivityStartMessage(
    attributes(),
    { ...pillsShown, quiet: false },
    { title: "Morning pills", body: PILLS_PROMPT },
    seconds(WINDOW_START),
  ),
  "start-quiet-steps.json": liveActivityStartMessage(
    attributes(),
    { ...showerShown, quiet: true },
    { title: "Shower", body: SHOWER_PROMPT },
    seconds(WINDOW_START + 6 * MIN),
  ),
  "update-step.json": liveActivityUpdateMessage(
    updateOf(
      fromLive(
        { ...shower, instance: instanceDoc({ currentStep: 1 }) },
        showerShown,
        WINDOW_START + 9 * MIN,
      ),
    ),
    seconds(WINDOW_START + 9 * MIN),
  ),
  "end-done.json": liveActivityEndMessage(
    endOf(
      fromLive(
        {
          ...pills,
          instance: instanceDoc({ state: "confirmed", confirmedAt: WINDOW_START + 12 * MIN }),
        },
        pillsShown,
        WINDOW_START + 12 * MIN + 1_000,
      ),
    ),
    ACCEPTED_AT,
    seconds(WINDOW_START + 12 * MIN + 1_000),
  ),
  "end-done-receipt.json": liveActivityEndMessage(
    endOf(
      fromLive(
        {
          ...pills,
          instance: instanceDoc({
            state: "confirmed",
            confirmedAt: WINDOW_START + 12 * MIN,
            confirmedVia: "live_activity",
            confirmedBy: PHONE_USER_ID,
          }),
        },
        pillsShown,
        WINDOW_START + 12 * MIN + 1_000,
      ),
    ),
    ACCEPTED_AT,
    seconds(WINDOW_START + 12 * MIN + 1_000),
  ),
  "end-window-closed.json": liveActivityEndMessage(
    endOf(
      fromLive(
        { ...pills, instance: instanceDoc({ state: "missed" }) },
        pillsShown,
        WINDOW_START + 60 * MIN + 20_000,
      ),
    ),
    ACCEPTED_AT,
    seconds(WINDOW_START + 60 * MIN + 20_000),
  ),
  "alert-reprompt.json": alertMessage(
    "Morning pills",
    PILLS_PROMPT,
    {
      notification_id: "kd7x1c3v5b7n9m2q4w6e8r0t1y3u5p7a",
      kind: "senior_prompt",
      household_id: "jn7a1b2c3d4e5f6g7h8j9k0m1n2p3q4r",
      task_instance_id: INSTANCE_ID,
    },
    pushStyle("senior_prompt", { kind: "device" }),
    seconds(WINDOW_START + 15 * MIN),
  ),
  "background-refresh.json": backgroundRefreshMessage(),
  "widget-reload.json": widgetReloadMessage(),
};

function goldenText(message: ApnsMessage): string {
  const golden = {
    headers: buildHeaders(CONFIG, "PROVIDER_TOKEN", message),
    payload: JSON.parse(message.body) as unknown,
  };
  return `${JSON.stringify(golden, null, 2)}\n`;
}

describe("APNs goldens the Swift tests decode", () => {
  const update = process.env.LIVE_ACTIVITY_GOLDENS === "update";

  test.each(Object.entries(CASES))("%s is reproduced byte for byte", (file, message) => {
    const text = goldenText(message);
    if (update) writeFileSync(new URL(file, GOLDENS), text);
    expect(text).toBe(readFileSync(new URL(file, GOLDENS), "utf8"));
  });

  test.each(Object.entries(CASES))("%s holds the bytes that go on the wire", (file, message) => {
    const golden = JSON.parse(readFileSync(new URL(file, GOLDENS), "utf8")) as { payload: unknown };
    expect(JSON.stringify(golden.payload)).toBe(message.body);
    expect(new TextEncoder().encode(message.body).length).toBeLessThanOrEqual(4096);
  });

  test("every golden file belongs to a case", () => {
    expect(readdirSync(GOLDENS).sort()).toEqual(Object.keys(CASES).sort());
  });
});
