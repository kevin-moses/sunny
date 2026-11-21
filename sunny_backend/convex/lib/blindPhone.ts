import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { householdCaregivers } from "./access";
import { insertNotification } from "./delivery";
import { HOUR_MS } from "./time";

export const TELL_CAREGIVERS_AFTER_BLIND_MS = 24 * HOUR_MS;

const LOOK_AGAIN_AFTER_MS = HOUR_MS;

const BLIND_SWEEP_BATCH = 50;

export function blindNoticeWords(seniorName: string): { title: string; body: string } {
  return {
    title: `${seniorName}'s phone is not showing tasks on its Lock Screen`,
    body: "Open Sunny on that phone, and check in Settings that Live Activities are switched on for Sunny.",
  };
}

export async function markBlind(
  ctx: MutationCtx,
  push: Doc<"phonePush">,
  now: number,
): Promise<void> {
  if (push.blindSince !== undefined) return;
  await ctx.db.patch(push._id, {
    blindSince: now,
    blindLookAt: now + TELL_CAREGIVERS_AFTER_BLIND_MS,
  });
}

async function hasPushToken(ctx: MutationCtx, userId: string): Promise<boolean> {
  const token = await ctx.db
    .query("pushTokens")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return token !== null;
}

async function tellCaregivers(
  ctx: MutationCtx,
  push: Doc<"phonePush">,
  now: number,
): Promise<void> {
  const device = await ctx.db.get(push.deviceId);
  const household = device === null ? null : await ctx.db.get(device.householdId);
  if (device === null || household === null) {
    await ctx.db.patch(push._id, { blindLookAt: undefined });
    return;
  }
  const recipients = [];
  if (!household.backgroundPaused) {
    for (const member of await householdCaregivers(ctx, household._id)) {
      if (await hasPushToken(ctx, member.userId)) recipients.push(member);
    }
  }
  if (recipients.length === 0) {
    await ctx.db.patch(push._id, { blindLookAt: now + LOOK_AGAIN_AFTER_MS });
    return;
  }
  await ctx.db.patch(push._id, { blindLookAt: undefined });
  const words = blindNoticeWords(household.seniorPreferredName);
  for (const member of recipients) {
    await insertNotification(ctx, {
      householdId: household._id,
      kind: "lock_screen_blind",
      recipientUserId: member.userId,
      ...words,
      payload: { deviceId: device._id, blindSince: push.blindSince },
    });
  }
}

export async function tellCaregiversOfBlindPhones(ctx: MutationCtx, now: number): Promise<void> {
  const due = await ctx.db
    .query("phonePush")
    .withIndex("by_blind_look_at", (q) => q.gte("blindLookAt", 0).lte("blindLookAt", now))
    .take(BLIND_SWEEP_BATCH);
  for (const push of due) await tellCaregivers(ctx, push, now);
  if (due.length === BLIND_SWEEP_BATCH) {
    await ctx.scheduler.runAfter(0, internal.phonePush.sweepBlindPhones, { now });
  }
}
