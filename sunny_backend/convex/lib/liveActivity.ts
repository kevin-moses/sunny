import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isAnytimeInstance } from "./anytime";
import { contentState } from "./apnsPayload";
import { isDoneState } from "./confirmRule";
import type { DeviceIcon } from "./deviceWording";
import { isDueEntry } from "./dueTask";
import { taskCards, timelineTask } from "./phoneTimeline";
import { minutes } from "./time";
import type {
  ActivityClosed,
  ActivityContent,
  ActivityEndReason,
  LiveActivityPhase,
  ReportedActivity,
} from "./validators";

export const ACTIVITY_CAP_MS = minutes(470);

export const RECEIPT_MS = 10_000;

export const CONTENT_MAX_BYTES = 3_000;

export const REPORT_GRACE_MS = 60_000;

const RELEVANCE_BASE_SECONDS = 4_000_000_000;

export interface ActivityAttributes {
  activityKey: string;
  instanceId: Id<"taskInstances">;
  icon: DeviceIcon;
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

export type ViewInput = { phoneCanConfirm: boolean } & (
  { subject: ActivitySubject; row: ActivityRow | null } | { subject: null; row: ActivityRow }
);

export type ActivityView =
  | { kind: "show"; content: ActivityContent; staleAt: number; relevance: number }
  | { kind: "end"; content: ActivityContent; reason: ActivityEndReason };

export type ActivityCommand =
  | { kind: "none" }
  | { kind: "update"; token: string; content: ActivityContent; staleAt: number }
  | { kind: "end"; token: string; content: ActivityContent; reason: ActivityEndReason };

export interface ActivityStart {
  content: ActivityContent;
  staleAt: number;
  relevance: number;
  quiet: boolean;
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
      card: current!,
      nextSteps: later.flatMap((next) => (next.stepText === null ? [] : [next.stepText])),
      closed: null,
    }),
  );
}

function ended(
  content: ActivityContent,
  closed: ActivityClosed,
  reason: ActivityEndReason,
): ActivityView {
  return { kind: "end", content: { ...content, closed }, reason };
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

export function wantsActivity(
  instance: Pick<Doc<"taskInstances">, "state" | "scheduledTime" | "windowEnd">,
  now: number,
): boolean {
  return isDueEntry(instance) && !isAnytimeInstance(instance) && now < instance.windowEnd;
}

export function activityView(input: ViewInput, now: number): ActivityView {
  const was = showing(input.row);
  if (was.kind === "ended") return { kind: "end", content: was.shown, reason: was.reason };
  if (input.subject === null) {
    return ended(input.row.shown, { kind: "over", at: now }, "instance_gone");
  }
  const { instance } = input.subject;
  const content = taskContent(input.subject, now);
  if (!input.phoneCanConfirm) return ended(content, { kind: "over", at: now }, "device_revoked");
  if (isDoneState(instance.state)) {
    return ended(content, { kind: "done", at: instance.confirmedAt ?? now }, "confirmed");
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
    return { kind: "end", token, content: view.content, reason: view.reason };
  }
  if (sameContent(row.shown, view.content)) return { kind: "none" };
  return { kind: "update", token, content: view.content, staleAt: view.staleAt };
}

export type ActivityDirective =
  | { key: string; directive: "update"; content: ActivityContent; staleAt: number }
  | { key: string; directive: "end"; content: ActivityContent | null };

export function reportedPhase(phase: OpenPhase, token: string | null, now: number): OpenPhase {
  switch (phase.kind) {
    case "starting":
      return token === null
        ? { kind: "started", acceptedAt: now, proof: "proven" }
        : { kind: "live", acceptedAt: now, updateToken: token, tokenAt: now };
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
  const phoneCanConfirm = device !== null && device.tokenHash !== undefined;
  if (instance === null || task === null) {
    return activityView({ subject: null, row, phoneCanConfirm }, now);
  }
  return activityView({ subject: { instance, task }, row, phoneCanConfirm }, now);
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

async function applyReportedActivity(
  ctx: MutationCtx,
  row: Doc<"liveActivities">,
  phase: OpenPhase,
  reported: ReportedActivity,
  now: number,
): Promise<ActivityDirective[]> {
  const view = await loadActivityView(ctx, row, now);
  if (!isOnPhone(reported)) {
    await endAsViewed(ctx, row, view, now);
    return [];
  }
  const next = reportedPhase(phase, reported.token, now);
  if (next !== phase) await ctx.db.patch(row._id, { phase: next });
  if (view.kind === "end") {
    return [{ key: reported.key, directive: "end", content: contentState(view.content) }];
  }
  if (sameContent(row.shown, view.content)) return [];
  return [
    {
      key: reported.key,
      directive: "update",
      content: contentState(view.content),
      staleAt: view.staleAt,
    },
  ];
}

export async function applyActivityReport(
  ctx: MutationCtx,
  device: Doc<"devices">,
  reported: ReportedActivity[],
  now: number,
): Promise<ActivityDirective[]> {
  const listed = new Set<Id<"liveActivities">>();
  const directives: ActivityDirective[] = [];
  for (const entry of reported) {
    const id = ctx.db.normalizeId("liveActivities", entry.key);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || row.deviceId !== device._id) {
      if (isOnPhone(entry)) directives.push({ key: entry.key, directive: "end", content: null });
      continue;
    }
    if (listed.has(row._id)) continue;
    listed.add(row._id);
    if (!isOpenPhase(row.phase)) {
      if (isOnPhone(entry)) {
        directives.push({ key: entry.key, directive: "end", content: contentState(row.shown) });
      }
      continue;
    }
    directives.push(...(await applyReportedActivity(ctx, row, row.phase, entry, now)));
  }
  for (const row of await openActivitiesOf(ctx, device._id)) {
    if (listed.has(row._id) || row.phase.kind === "ended" || row.phase.kind === "starting") {
      continue;
    }
    if (now - row.phase.acceptedAt < REPORT_GRACE_MS) continue;
    await endAsViewed(ctx, row, await loadActivityView(ctx, row, now), now);
  }
  return directives;
}
