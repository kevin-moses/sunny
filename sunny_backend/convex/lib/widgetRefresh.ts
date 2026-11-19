import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./access";
import { findPhonePush } from "./liveActivity";
import { minutes } from "./time";

export const WIDGET_REFRESH_GAP_MS = minutes(10);

export type RefreshState = NonNullable<Doc<"phonePush">["widgetRefresh"]>;

export type RefreshDecision =
  | { kind: "send" }
  | { kind: "trail"; state: { sentAt: number; trailingAt: number } }
  | { kind: "fold" };

export function refreshDecision(state: RefreshState | undefined, now: number): RefreshDecision {
  if (state === undefined) return { kind: "send" };
  if (state.trailingAt !== null && now <= state.trailingAt) return { kind: "fold" };
  const allowedAt = state.sentAt + WIDGET_REFRESH_GAP_MS;
  if (now >= allowedAt) return { kind: "send" };
  return { kind: "trail", state: { sentAt: state.sentAt, trailingAt: allowedAt } };
}

export async function sendWidgetRefresh(
  ctx: MutationCtx,
  push: Doc<"phonePush">,
  now: number,
): Promise<void> {
  await ctx.db.patch(push._id, { widgetRefresh: { sentAt: now, trailingAt: null } });
  await ctx.scheduler.runAfter(0, internal.phonePush.refreshWidgets, { deviceId: push.deviceId });
}

function backgroundPushSentAt(push: Doc<"phonePush">, now: number): boolean {
  return push.widgetPush === undefined && push.widgetRefresh?.sentAt === now;
}

export async function wakePhoneToReport(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  now: number,
): Promise<void> {
  const push = await findPhonePush(ctx, deviceId);
  if (push === null || backgroundPushSentAt(push, now)) return;
  await ctx.scheduler.runAfter(0, internal.phonePush.wakeToReport, { deviceId });
}

async function refreshPhone(ctx: MutationCtx, deviceId: Id<"devices">, now: number): Promise<void> {
  const push = await findPhonePush(ctx, deviceId);
  if (push === null) return;
  const decision = refreshDecision(push.widgetRefresh, now);
  switch (decision.kind) {
    case "fold":
      return;
    case "send":
      await sendWidgetRefresh(ctx, push, now);
      return;
    case "trail":
      await ctx.db.patch(push._id, { widgetRefresh: decision.state });
      await ctx.scheduler.runAt(decision.state.trailingAt, internal.phonePush.trailingRefresh, {
        deviceId,
      });
  }
}

export function phonePressedOn(actor: Actor): Id<"devices"> | null {
  return actor.kind === "senior_device" ? actor.device._id : null;
}

export async function requestWidgetRefresh(
  ctx: MutationCtx,
  actor: Actor,
  householdId: Id<"households">,
): Promise<void> {
  if (actor.kind === "system") return;
  const pressedOn = phonePressedOn(actor);
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_household", (q) => q.eq("householdId", householdId))
    .collect();
  const now = Date.now();
  for (const device of devices) {
    if (device.kind !== "senior_phone" || device._id === pressedOn) continue;
    await refreshPhone(ctx, device._id, now);
  }
}
