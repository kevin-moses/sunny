import type { Doc, Id } from "../_generated/dataModel";
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
} from "./validators";

export const ACTIVITY_CAP_MS = minutes(470);

export const RECEIPT_MS = 10_000;

export const CONTENT_MAX_BYTES = 3_000;

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

export function isOpenPhase(phase: LiveActivityPhase): boolean {
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
