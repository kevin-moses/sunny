import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { pushesSent } from "./deliveryMocks.helpers";
import type { SentPush } from "./deliveryMocks.helpers";
import { activityView } from "./lib/liveActivity";
import type { ActivityContent, LiveActivityPhase } from "./lib/validators";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.helpers.ts"]);

export const MIN = 60_000;

export const DAY = "2026-11-13";

export const START_TOKEN = "5a".repeat(80);

export const UPDATE_TOKEN = "c3".repeat(80);

export const WIDGET_TOKEN = "d4".repeat(40);

export const ALERT_TOKEN = "e5".repeat(32);

const SETTLE_MS = 5_000;

const SETTLE_REAL_CAP_MS = 4_000;

export function local(hhmm: string, date: string = DAY): number {
  return Date.parse(`${date}T${hhmm}:00-05:00`);
}

export function about(ms: number): number {
  return expect.closeTo(ms, -2) as number;
}

export function setNow(ms: number): void {
  vi.setSystemTime(new Date(ms));
}

export function makePhoneBackend() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  workpoolTest.register(t, "deliveryPool");
  return t;
}

export type PhoneBackend = ReturnType<typeof makePhoneBackend>;

export interface PhoneFixture {
  t: PhoneBackend;
  householdId: Id<"households">;
  phoneId: Id<"devices">;
  displayId: Id<"devices">;
  deviceToken: string;
  caregiver: string;
  phoneUser: string;
  displayUser: string;
}

export interface TaskSpec {
  title: string;
  time: string;
  type?: "medication" | "routine" | "reminder";
  windowMinutes?: number;
  checklistItems?: string[];
  spokenPrompt?: string;
  screenSentence?: string;
  pillDescription?: string;
}

async function issueToken(t: PhoneBackend, subject: string): Promise<string> {
  const { deviceToken } = await t.withIdentity({ subject }).action(api.deviceApi.issueToken, {});
  return deviceToken;
}

async function loadApnsBeforeConcurrentUse(): Promise<void> {
  await import("./apns");
}

export async function phoneHousehold(t: PhoneBackend, prefix = ""): Promise<PhoneFixture> {
  await loadApnsBeforeConcurrentUse();
  const pat = t.withIdentity({ subject: `${prefix}pat` });
  const householdId = await pat.mutation(api.households.create, {
    seniorPreferredName: "Mom",
    timezone: "America/New_York",
    caregiverDisplayName: "Pat",
  });
  const ids: Id<"devices">[] = [];
  for (const [grants, userId] of [
    ["senior_phone", `${prefix}phone`],
    ["home_display", `${prefix}display`],
  ] as const) {
    const { code } = await pat.mutation(api.households.createJoinCode, { householdId, grants });
    const paired = await t.mutation(internal.households.pairDevice, { code, userId });
    ids.push(paired.deviceId);
  }
  await t.run(async (ctx) => {
    await ctx.db.insert("pushTokens", { userId: `${prefix}phone`, token: ALERT_TOKEN });
  });
  return {
    t,
    householdId,
    phoneId: ids[0]!,
    displayId: ids[1]!,
    deviceToken: await issueToken(t, `${prefix}phone`),
    caregiver: `${prefix}pat`,
    phoneUser: `${prefix}phone`,
    displayUser: `${prefix}display`,
  };
}

export async function displayToken(f: PhoneFixture): Promise<string> {
  return await issueToken(f.t, f.displayUser);
}

export async function secondPhone(f: PhoneFixture, alertToken: string): Promise<PhoneFixture> {
  const { code } = await f.t
    .withIdentity({ subject: f.caregiver })
    .mutation(api.households.createJoinCode, {
      householdId: f.householdId,
      grants: "senior_phone",
    });
  const phoneUser = `${f.phoneUser}-2`;
  const paired = await f.t.mutation(internal.households.pairDevice, { code, userId: phoneUser });
  await f.t.run(async (ctx) => {
    await ctx.db.insert("pushTokens", { userId: phoneUser, token: alertToken });
  });
  return {
    ...f,
    phoneId: paired.deviceId,
    phoneUser,
    deviceToken: await issueToken(f.t, phoneUser),
  };
}

export async function addTask(f: PhoneFixture, spec: TaskSpec): Promise<Id<"taskInstances">> {
  const { title, time, ...rest } = spec;
  const taskId = await f.t.withIdentity({ subject: f.caregiver }).mutation(api.tasks.create, {
    householdId: f.householdId,
    type: "medication",
    title,
    displayLabel: title,
    times: [time],
    ...rest,
  });
  return await f.t.run(async (ctx) => {
    const instance = await ctx.db
      .query("taskInstances")
      .withIndex("by_task_date_time", (q) => q.eq("taskId", taskId).eq("localDate", DAY))
      .first();
    return instance!._id;
  });
}

export async function tick(f: PhoneFixture, now: number): Promise<void> {
  setNow(now);
  await f.t.mutation(internal.scheduler.tickHousehold, { householdId: f.householdId, now });
}

async function finishRunning(t: PhoneBackend, realDeadline: number): Promise<void> {
  let finished = false;
  void t.finishInProgressScheduledFunctions().then(() => {
    finished = true;
  });
  while (!finished) {
    if (vi.getRealSystemTime() > realDeadline) {
      throw new Error(
        `settle: scheduled functions were still running after ${SETTLE_REAL_CAP_MS} ms of real time`,
      );
    }
    await vi.advanceTimersByTimeAsync(0);
  }
}

export async function settle(t: PhoneBackend, ms = SETTLE_MS): Promise<void> {
  const realDeadline = vi.getRealSystemTime() + SETTLE_REAL_CAP_MS;
  let reached = false;
  setTimeout(() => {
    reached = true;
  }, ms);
  await finishRunning(t, realDeadline);
  while (!reached) {
    await vi.advanceTimersToNextTimerAsync();
    await finishRunning(t, realDeadline);
  }
}

export async function putPushState(
  f: PhoneFixture,
  body: unknown,
  deviceToken: string | null = f.deviceToken,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deviceToken !== null) headers.Authorization = `Bearer ${deviceToken}`;
  return await f.t.fetch("/device/push-state", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function postConfirm(
  f: PhoneFixture,
  deviceToken: string,
  body: unknown,
): Promise<Response> {
  return await f.t.fetch("/device/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify(body),
  });
}

export async function activities(f: PhoneFixture): Promise<Doc<"liveActivities">[]> {
  return await f.t.run(async (ctx) => await ctx.db.query("liveActivities").collect());
}

export async function activity(
  f: PhoneFixture,
  id: Id<"liveActivities">,
): Promise<Doc<"liveActivities">> {
  return (await f.t.run(async (ctx) => await ctx.db.get(id)))!;
}

export async function phonePushRow(
  f: PhoneFixture,
  deviceId: Id<"devices"> = f.phoneId,
): Promise<Doc<"phonePush"> | null> {
  return await f.t.run(
    async (ctx) =>
      await ctx.db
        .query("phonePush")
        .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
        .unique(),
  );
}

export async function patchInstance(
  f: PhoneFixture,
  instanceId: Id<"taskInstances">,
  patch: Partial<Doc<"taskInstances">>,
): Promise<void> {
  await f.t.run(async (ctx) => await ctx.db.patch(instanceId, patch));
}

export async function insertActivity(
  f: PhoneFixture,
  instanceId: Id<"taskInstances">,
  phase: LiveActivityPhase,
  deviceId: Id<"devices"> = f.phoneId,
): Promise<Id<"liveActivities">> {
  return await f.t.run(async (ctx) => {
    const instance = (await ctx.db.get(instanceId))!;
    const task = (await ctx.db.get(instance.taskId))!;
    const view = activityView(
      { subject: { instance, task }, row: null, phone: { userId: null, canConfirm: true } },
      instance.windowStart,
    );
    return await ctx.db.insert("liveActivities", {
      householdId: instance.householdId,
      deviceId,
      taskInstanceId: instanceId,
      windowEnd: instance.windowEnd,
      phase,
      shown: view.content,
      pushTimestamp: Math.floor(instance.windowStart / 1000),
      quiet: false,
    });
  });
}

export interface ActivityAps {
  timestamp: number;
  event: "start" | "update" | "end";
  "content-state": ActivityContent;
  "stale-date"?: number;
  "dismissal-date"?: number;
}

export interface StartAps extends ActivityAps {
  "attributes-type": string;
  attributes: { activityKey: string; instanceId: string; receiptMs: number };
  alert: { title: string; body: string; sound?: string };
  "stale-date": number;
  "relevance-score": number;
}

export function backgroundPushes(): SentPush[] {
  return pushesSent().filter((push) => push.message.pushType === "background");
}

export function activityPushes(): SentPush[] {
  return pushesSent().filter((push) => push.message.pushType === "liveactivity");
}

function activityAps(event: ActivityAps["event"]): (SentPush & { aps: ActivityAps })[] {
  return activityPushes()
    .map((push) => ({ ...push, aps: push.payload.aps as ActivityAps }))
    .filter((push) => push.aps.event === event);
}

export function starts(): StartAps[] {
  return activityAps("start").map((push) => push.aps as StartAps);
}

export function updates(): (SentPush & { aps: ActivityAps })[] {
  return activityAps("update");
}

export function ends(): (SentPush & { aps: ActivityAps })[] {
  return activityAps("end");
}

export async function reportStartToken(f: PhoneFixture): Promise<void> {
  const response = await putPushState(f, {
    liveActivityStart: { token: START_TOKEN, enabled: true },
  });
  expect(response.status).toBe(200);
}

async function reportOpenActivities(f: PhoneFixture, token: string | null): Promise<unknown[]> {
  const open = (await activities(f)).filter((row) => row.phase.kind !== "ended");
  const response = await putPushState(f, {
    activities: open.map((row) => ({ key: row._id, token, state: "active" })),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { activities: unknown[] }).activities;
}

export async function proveStarts(f: PhoneFixture): Promise<void> {
  await reportOpenActivities(f, null);
}

export async function reportUpdateToken(f: PhoneFixture): Promise<unknown[]> {
  return await reportOpenActivities(f, UPDATE_TOKEN);
}

export async function pressOnDisplay(
  f: PhoneFixture,
  instanceId: Id<"taskInstances">,
  step?: number,
): Promise<string> {
  const response = await postConfirm(f, await displayToken(f), {
    instanceId,
    pressedAgoMs: 0,
    via: "button",
    ...(step === undefined ? {} : { step }),
  });
  return ((await response.json()) as { status: string }).status;
}

export async function confirmOnDisplay(
  f: PhoneFixture,
  instanceId: Id<"taskInstances">,
): Promise<void> {
  expect(await pressOnDisplay(f, instanceId)).toBe("confirmed");
}

export async function outbox(
  f: PhoneFixture,
  instanceId: Id<"taskInstances">,
): Promise<Doc<"notificationOutbox">[]> {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_task_instance", (q) => q.eq("taskInstanceId", instanceId))
      .collect();
    return rows.filter((row) => row.recipientDeviceId === f.phoneId);
  });
}
