import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isAnytimeInstance } from "./anytime";
import { contentState, liveActivityStartMessage } from "./apnsPayload";
import { isDoneState } from "./confirmRule";
import { isDueEntry } from "./dueTask";
import { taskCards, timelineTask } from "./phoneTimeline";
import { minutes } from "./time";
import type {
  ActivityClosed,
  ActivityContent,
  ActivityEndReason,
  ApnsMessage,
  LiveActivityPhase,
  ReportedActivity,
} from "./validators";

export const ACTIVITY_CAP_MS = minutes(470);

export const RECEIPT_MS = 10_000;

export const CONTENT_MAX_BYTES = 3_000;

export const REPORT_GRACE_MS = 60_000;

export const PROOF_WAIT_MS = 45_000;

export const MAX_OPEN_ACTIVITIES = 3;

const RELEVANCE_BASE_SECONDS = 4_000_000_000;

export interface ActivityAttributes {
  activityKey: string;
  instanceId: Id<"taskInstances">;
  receiptMs: number;
}

export interface ActivitySubject {
  instance: Doc<"taskInstances">;
  task: Doc<"tasks">;
}

export interface ActivityRow {
  phase: LiveActivityPhase;
  shown: ActivityContent;
  windowEnd: number;
}

export interface ActivityPhone {
  userId: string | null;
  canConfirm: boolean;
}

export type ViewInput = { phone: ActivityPhone } & (
  { subject: ActivitySubject; row: ActivityRow | null } | { subject: null; row: ActivityRow }
);

export type ActivityView =
  | { kind: "show"; content: ActivityContent; staleAt: number; relevance: number }
  | {
      kind: "end";
      content: ActivityContent;
      reason: ActivityEndReason;
      receiptUntil: number | null;
    };

export type ActivityCommand =
  | { kind: "none" }
  | { kind: "update"; token: string; content: ActivityContent; staleAt: number }
  | {
      kind: "end";
      token: string;
      content: ActivityContent;
      reason: ActivityEndReason;
      receiptUntil: number | null;
    };

export interface ActivityStart {
  content: ActivityContent;
  staleAt: number;
  relevance: number;
  quiet: boolean;
}

export interface StartPlan extends ActivityStart {
  token: string;
  instanceId: Id<"taskInstances">;
  windowEnd: number;
  resume: Id<"liveActivities"> | null;
  timestamp: number;
}

type Showing =
  | { kind: "nothing" }
  | { kind: "open"; since: number }
  | { kind: "ended"; shown: ActivityContent; reason: ActivityEndReason };

function contentBytes(content: ActivityContent): number {
  return new TextEncoder().encode(JSON.stringify(contentState(content))).length;
}

export function sameContent(a: ActivityContent, b: ActivityContent): boolean {
  return JSON.stringify(contentState(a)) === JSON.stringify(contentState(b));
}

export function fitContent(content: ActivityContent): ActivityContent {
  let fitted = content;
  while (fitted.nextSteps.length > 0 && contentBytes(fitted) > CONTENT_MAX_BYTES) {
    fitted = { ...fitted, nextSteps: fitted.nextSteps.slice(0, -1) };
  }
  return fitted;
}

function taskContent(subject: ActivitySubject, now: number): ActivityContent {
  const [current, ...later] = taskCards(timelineTask(subject.instance, subject.task, now));
  return fitContent(
    contentState({
      card: current,
      nextSteps: later.flatMap((next) => (next.stepText === null ? [] : [next.stepText])),
      closed: null,
    }),
  );
}

function ended(
  content: ActivityContent,
  closed: ActivityClosed,
  reason: ActivityEndReason,
  receiptUntil: number | null = null,
): ActivityView {
  return { kind: "end", content: { ...content, closed }, reason, receiptUntil };
}

function receiptUntil(
  instance: Pick<Doc<"taskInstances">, "confirmedVia" | "confirmedBy" | "confirmedAt">,
  phone: ActivityPhone,
): number | null {
  const pressedOnThisActivity =
    instance.confirmedVia === "live_activity" &&
    phone.userId !== null &&
    instance.confirmedBy === phone.userId;
  if (!pressedOnThisActivity || instance.confirmedAt === undefined) return null;
  return instance.confirmedAt + RECEIPT_MS;
}

function showing(row: ActivityRow | null): Showing {
  if (row === null) return { kind: "nothing" };
  const { phase } = row;
  switch (phase.kind) {
    case "starting":
      return { kind: "open", since: phase.since };
    case "started":
    case "live":
      return { kind: "open", since: phase.acceptedAt };
    case "ended":
      return { kind: "ended", shown: row.shown, reason: phase.reason };
  }
}

export type OpenPhase = Exclude<LiveActivityPhase, { kind: "ended" }>;

export function isOpenPhase(phase: LiveActivityPhase): phase is OpenPhase {
  return phase.kind !== "ended";
}

export function nextPushTimestamp(
  row: Pick<Doc<"liveActivities">, "pushTimestamp"> | null,
  now: number,
): number {
  const nowSeconds = Math.floor(now / 1000);
  return row === null ? nowSeconds : Math.max(nowSeconds, row.pushTimestamp + 1);
}

export function wantsActivity(
  instance: Pick<Doc<"taskInstances">, "state" | "scheduledTime" | "windowEnd">,
  now: number,
): boolean {
  return isDueEntry(instance) && !isAnytimeInstance(instance) && now < instance.windowEnd;
}

export function activityView(input: ViewInput, now: number): ActivityView {
  const was = showing(input.row);
  if (was.kind === "ended") {
    return { kind: "end", content: was.shown, reason: was.reason, receiptUntil: null };
  }
  if (input.subject === null) {
    return ended(input.row.shown, { kind: "over", at: now }, "instance_gone");
  }
  const { instance } = input.subject;
  const content = taskContent(input.subject, now);
  if (!input.phone.canConfirm) return ended(content, { kind: "over", at: now }, "device_revoked");
  if (isDoneState(instance.state)) {
    return ended(
      content,
      { kind: "done", at: instance.confirmedAt ?? now },
      "confirmed",
      receiptUntil(instance, input.phone),
    );
  }
  if (!wantsActivity(instance, now)) {
    return ended(content, { kind: "over", at: Math.min(now, instance.windowEnd) }, "window_closed");
  }
  const capAt = (was.kind === "open" ? was.since : now) + ACTIVITY_CAP_MS;
  if (now >= capAt) return ended(content, { kind: "over", at: capAt }, "expired");
  return {
    kind: "show",
    content,
    staleAt: Math.min(instance.windowEnd, capAt),
    relevance: RELEVANCE_BASE_SECONDS - Math.floor(instance.windowStart / 1000),
  };
}

export function nextCommand(row: ActivityRow, view: ActivityView): ActivityCommand {
  if (row.phase.kind !== "live") return { kind: "none" };
  const token = row.phase.updateToken;
  if (view.kind === "end") {
    const { content, reason, receiptUntil } = view;
    return { kind: "end", token, content, reason, receiptUntil };
  }
  if (sameContent(row.shown, view.content)) return { kind: "none" };
  return { kind: "update", token, content: view.content, staleAt: view.staleAt };
}

export type ActivityDirective =
  | { key: string; directive: "update"; content: ActivityContent; staleAt: number }
  | { key: string; directive: "end"; content: ActivityContent | null };

export function firstShownPhase(token: string | null, now: number): OpenPhase {
  return token === null
    ? { kind: "started", acceptedAt: now, proof: "proven" }
    : { kind: "live", acceptedAt: now, updateToken: token, tokenAt: now };
}

export function reportedPhase(phase: OpenPhase, token: string | null, now: number): OpenPhase {
  switch (phase.kind) {
    case "starting":
      return firstShownPhase(token, now);
    case "started":
      if (token !== null) {
        return { kind: "live", acceptedAt: phase.acceptedAt, updateToken: token, tokenAt: now };
      }
      return phase.proof === "proven" ? phase : { ...phase, proof: "proven" };
    case "live":
      return token === null || token === phase.updateToken
        ? phase
        : { ...phase, updateToken: token, tokenAt: now };
  }
}

export async function loadActivityView(
  ctx: QueryCtx,
  row: Doc<"liveActivities">,
  now: number,
): Promise<ActivityView> {
  const instance = await ctx.db.get(row.taskInstanceId);
  const task = instance === null ? null : await ctx.db.get(instance.taskId);
  const device = await ctx.db.get(row.deviceId);
  const phone: ActivityPhone = {
    userId: device?.userId ?? null,
    canConfirm: device !== null && device.tokenHash !== undefined,
  };
  if (instance === null || task === null) return activityView({ subject: null, row, phone }, now);
  return activityView({ subject: { instance, task }, row, phone }, now);
}

export async function endActivity(
  ctx: MutationCtx,
  row: Doc<"liveActivities">,
  reason: ActivityEndReason,
  now: number,
  shown: ActivityContent = row.shown,
): Promise<void> {
  await ctx.db.patch(row._id, { phase: { kind: "ended", at: now, reason }, shown });
}

async function endAsViewed(
  ctx: MutationCtx,
  row: Doc<"liveActivities">,
  view: ActivityView,
  now: number,
): Promise<void> {
  if (view.kind === "end") await endActivity(ctx, row, view.reason, now, view.content);
  else await endActivity(ctx, row, "ended_on_phone", now);
}

export async function openActivitiesOf(
  ctx: QueryCtx,
  deviceId: Id<"devices">,
): Promise<Doc<"liveActivities">[]> {
  const rows = await ctx.db
    .query("liveActivities")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .collect();
  return rows.filter((row) => isOpenPhase(row.phase));
}

function isOnPhone(reported: ReportedActivity): boolean {
  return reported.state === "active" || reported.state === "stale";
}

export interface ReportOutcome {
  directives: ActivityDirective[];
  behind: Id<"liveActivities">[];
}

function directiveFor(key: string, row: ActivityRow, view: ActivityView): ActivityDirective[] {
  if (view.kind === "end") {
    return [{ key, directive: "end", content: contentState(view.content) }];
  }
  if (sameContent(row.shown, view.content)) return [];
  return [{ key, directive: "update", content: contentState(view.content), staleAt: view.staleAt }];
}

async function settleCueAsShown(
  ctx: MutationCtx,
  outboxId: Id<"notificationOutbox">,
  now: number,
): Promise<void> {
  const cue = await ctx.db.get(outboxId);
  if (cue === null || cue.state !== "pending") return;
  await ctx.db.patch(cue._id, { state: "sent", channel: "live_activity", settledAt: now });
}

async function applyReportedActivity(
  ctx: MutationCtx,
  row: Doc<"liveActivities">,
  phase: OpenPhase,
  reported: ReportedActivity,
  now: number,
): Promise<ReportOutcome> {
  if (phase.kind === "starting") await settleCueAsShown(ctx, phase.outboxId, now);
  const view = await loadActivityView(ctx, row, now);
  if (!isOnPhone(reported)) {
    await endAsViewed(ctx, row, view, now);
    return { directives: [], behind: [] };
  }
  const next = reportedPhase(phase, reported.token, now);
  const directives = directiveFor(reported.key, row, view);
  if (next.kind === "started" && view.kind === "end") {
    await endActivity(ctx, row, view.reason, now, view.content);
    return { directives, behind: [] };
  }
  if (next !== phase) await ctx.db.patch(row._id, { phase: next });
  return { directives, behind: next.kind === "live" && directives.length > 0 ? [row._id] : [] };
}

async function openForReport(
  ctx: MutationCtx,
  row: Doc<"liveActivities">,
  reported: ReportedActivity,
  now: number,
): Promise<{ row: Doc<"liveActivities">; phase: OpenPhase } | null> {
  const { phase } = row;
  if (isOpenPhase(phase)) return { row, phase };
  if (phase.reason !== "start_failed" || !isOnPhone(reported)) return null;
  const shown = firstShownPhase(reported.token, now);
  await ctx.db.patch(row._id, { phase: shown });
  return { row: { ...row, phase: shown }, phase: shown };
}

export async function applyActivityReport(
  ctx: MutationCtx,
  device: Doc<"devices">,
  reported: ReportedActivity[],
  now: number,
): Promise<ReportOutcome> {
  const listed = new Set<Id<"liveActivities">>();
  const directives: ActivityDirective[] = [];
  const behind: Id<"liveActivities">[] = [];
  for (const entry of reported) {
    const id = ctx.db.normalizeId("liveActivities", entry.key);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || row.deviceId !== device._id) {
      if (isOnPhone(entry)) directives.push({ key: entry.key, directive: "end", content: null });
      continue;
    }
    if (listed.has(row._id)) continue;
    listed.add(row._id);
    const open = await openForReport(ctx, row, entry, now);
    if (open === null) {
      if (isOnPhone(entry)) {
        directives.push({ key: entry.key, directive: "end", content: contentState(row.shown) });
      }
      continue;
    }
    const outcome = await applyReportedActivity(ctx, open.row, open.phase, entry, now);
    directives.push(...outcome.directives);
    behind.push(...outcome.behind);
  }
  for (const row of await openActivitiesOf(ctx, device._id)) {
    if (listed.has(row._id) || row.phase.kind === "ended" || row.phase.kind === "starting") {
      continue;
    }
    if (now - row.phase.acceptedAt < REPORT_GRACE_MS) continue;
    await endAsViewed(ctx, row, await loadActivityView(ctx, row, now), now);
  }
  return { directives, behind };
}

export async function findPhonePush(
  ctx: QueryCtx,
  deviceId: Id<"devices">,
): Promise<Doc<"phonePush"> | null> {
  return await ctx.db
    .query("phonePush")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();
}

function isActivityCue(row: Doc<"notificationOutbox">): row is Doc<"notificationOutbox"> & {
  taskInstanceId: Id<"taskInstances">;
  recipientDeviceId: Id<"devices">;
} {
  return (
    (row.kind === "senior_prompt" || row.kind === "senior_reshow") &&
    row.taskInstanceId !== undefined &&
    row.recipientDeviceId !== undefined
  );
}

export async function activitiesOfInstance(
  ctx: QueryCtx,
  instanceId: Id<"taskInstances">,
): Promise<Doc<"liveActivities">[]> {
  return await ctx.db
    .query("liveActivities")
    .withIndex("by_instance", (q) => q.eq("taskInstanceId", instanceId))
    .collect();
}

async function activitiesFor(
  ctx: QueryCtx,
  instanceId: Id<"taskInstances">,
  deviceId: Id<"devices">,
): Promise<Doc<"liveActivities">[]> {
  const rows = await activitiesOfInstance(ctx, instanceId);
  return rows.filter((row) => row.deviceId === deviceId);
}

function isStartOf(row: Doc<"liveActivities">, outboxId: Id<"notificationOutbox">): boolean {
  return row.phase.kind === "starting" && row.phase.outboxId === outboxId;
}

interface StartCue {
  instanceId: Id<"taskInstances">;
  outboxId: Id<"notificationOutbox"> | null;
  quiet: boolean;
}

async function planStartOf(
  ctx: QueryCtx,
  cue: StartCue,
  device: Doc<"devices">,
  now: number,
): Promise<StartPlan | null> {
  if (device.kind !== "senior_phone" || device.tokenHash === undefined) return null;
  const push = await findPhonePush(ctx, device._id);
  if (push === null || push.liveActivityStart === undefined || push.blindSince !== undefined) {
    return null;
  }
  const instance = await ctx.db.get(cue.instanceId);
  const task = instance === null ? null : await ctx.db.get(instance.taskId);
  if (instance === null || task === null) return null;
  const rows = await activitiesFor(ctx, instance._id, device._id);
  const { outboxId } = cue;
  const resume = outboxId === null ? null : (rows.find((r) => isStartOf(r, outboxId)) ?? null);
  const earlier = rows.filter((r) => r !== resume);
  const blocked = cue.quiet ? earlier.some((r) => isOpenPhase(r.phase)) : earlier.length > 0;
  if (blocked) return null;
  const open = (await openActivitiesOf(ctx, device._id)).filter((r) => r._id !== resume?._id);
  if (open.length >= MAX_OPEN_ACTIVITIES) return null;
  const view = activityView(
    {
      subject: { instance, task },
      row: resume,
      phone: { userId: device.userId, canConfirm: true },
    },
    now,
  );
  if (view.kind !== "show") return null;
  return {
    token: push.liveActivityStart.token,
    content: view.content,
    staleAt: view.staleAt,
    relevance: view.relevance,
    quiet: cue.quiet,
    instanceId: instance._id,
    windowEnd: instance.windowEnd,
    resume: resume?._id ?? null,
    timestamp: nextPushTimestamp(resume, now),
  };
}

export async function planStart(
  ctx: QueryCtx,
  row: Doc<"notificationOutbox">,
  device: Doc<"devices">,
  now: number,
): Promise<StartPlan | null> {
  if (!isActivityCue(row)) return null;
  const cue = {
    instanceId: row.taskInstanceId,
    outboxId: row._id,
    quiet: row.kind === "senior_reshow",
  };
  return await planStartOf(ctx, cue, device, now);
}

export async function canShowAgain(
  ctx: QueryCtx,
  instanceId: Id<"taskInstances">,
  device: Doc<"devices">,
  now: number,
): Promise<boolean> {
  const cue = { instanceId, outboxId: null, quiet: true };
  return (await planStartOf(ctx, cue, device, now)) !== null;
}

export async function openActivity(
  ctx: MutationCtx,
  row: Doc<"notificationOutbox">,
  device: Doc<"devices">,
  plan: StartPlan,
  now: number,
): Promise<{ activityId: Id<"liveActivities">; message: ApnsMessage }> {
  let activityId = plan.resume;
  if (activityId === null) {
    activityId = await ctx.db.insert("liveActivities", {
      householdId: row.householdId,
      deviceId: device._id,
      taskInstanceId: plan.instanceId,
      windowEnd: plan.windowEnd,
      phase: { kind: "starting", outboxId: row._id, since: now },
      shown: plan.content,
      pushTimestamp: plan.timestamp,
      quiet: plan.quiet,
    });
  } else {
    await ctx.db.patch(activityId, { shown: plan.content, pushTimestamp: plan.timestamp });
  }
  const attributes: ActivityAttributes = {
    activityKey: activityId,
    instanceId: plan.instanceId,
    receiptMs: RECEIPT_MS,
  };
  const alert = { title: row.title, body: row.body };
  return {
    activityId,
    message: liveActivityStartMessage(attributes, plan, alert, plan.timestamp),
  };
}

async function startOf(
  ctx: QueryCtx,
  row: Doc<"notificationOutbox">,
): Promise<Doc<"liveActivities"> | null> {
  if (!isActivityCue(row)) return null;
  const rows = await activitiesFor(ctx, row.taskInstanceId, row.recipientDeviceId);
  return rows.find((r) => isStartOf(r, row._id)) ?? null;
}

export async function markStarted(
  ctx: MutationCtx,
  row: Doc<"notificationOutbox">,
  now: number,
): Promise<void> {
  const start = await startOf(ctx, row);
  if (start === null) return;
  await ctx.db.patch(start._id, { phase: { kind: "started", acceptedAt: now, proof: "awaited" } });
  await ctx.scheduler.runAfter(PROOF_WAIT_MS, internal.liveActivity.checkProof, {
    activityId: start._id,
  });
}

export async function closeStart(
  ctx: MutationCtx,
  row: Doc<"notificationOutbox">,
  now: number,
): Promise<void> {
  const start = await startOf(ctx, row);
  if (start !== null) await endActivity(ctx, start, "start_failed", now);
}
