import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { postMailbox } from "./lib/chatPosts";
import { MAIL_SERVICES, PROBE_EVERY_MS, holdGate, holdOf, holdService } from "./lib/serviceHolds";
import type { HoldService } from "./lib/serviceHolds";

const MAX_STORED_ERROR = 2000;
const NOTE_PAGE = 100;

export const MAIL_HELD_NOTE = "Sunny can't read mail right now; it will catch up on its own.";

export const open = internalMutation({
  args: { service: holdService, error: v.string(), since: v.number() },
  handler: async (ctx, { service, error, since }): Promise<boolean> => {
    const hold = await holdOf(ctx, service);
    if (hold?.open) return false;
    if (hold?.closedAt !== undefined && since <= hold.closedAt) return false;
    const now = Date.now();
    const mailWasRead =
      MAIL_SERVICES.includes(service) && (await holdGate(ctx, MAIL_SERVICES, now)) === "free";
    const fields = {
      open: true,
      since,
      error: error.slice(0, MAX_STORED_ERROR),
      openedAt: now,
      probeAt: now + PROBE_EVERY_MS,
    };
    if (hold) await ctx.db.patch(hold._id, fields);
    else await ctx.db.insert("serviceHolds", { service, ...fields });
    console.error(`Holding ${service} until a probe succeeds: ${error}`);
    if (mailWasRead) {
      await ctx.scheduler.runAfter(0, internal.serviceHolds.noteMailHeld, { cursor: null });
    }
    return true;
  },
});

export const close = internalMutation({
  args: { services: v.array(holdService), since: v.number() },
  handler: async (ctx, { services, since }): Promise<HoldService[]> => {
    const closed: HoldService[] = [];
    for (const service of services) {
      const hold = await holdOf(ctx, service);
      if (!hold?.open || since <= hold.since) continue;
      await ctx.db.patch(hold._id, { open: false, closedAt: Date.now() });
      console.log(`Released the ${service} hold`);
      closed.push(service);
    }
    return closed;
  },
});

export const noteMailHeld = internalMutation({
  args: { cursor: v.union(v.null(), v.string()) },
  handler: async (ctx, { cursor }): Promise<number> => {
    const now = Date.now();
    if ((await holdGate(ctx, MAIL_SERVICES, now)) === "free") return 0;
    const page = await ctx.db
      .query("mailboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .paginate({ cursor, numItems: NOTE_PAGE });
    let noted = 0;
    for (const mailbox of page.page) {
      const household = await ctx.db.get(mailbox.householdId);
      if (!household) continue;
      await postMailbox(ctx, household, MAIL_HELD_NOTE, now);
      noted += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.serviceHolds.noteMailHeld, {
        cursor: page.continueCursor,
      });
    }
    return noted;
  },
});

export async function openHold(
  ctx: ActionCtx,
  service: HoldService,
  error: string,
  since: number,
): Promise<void> {
  await ctx.runMutation(internal.serviceHolds.open, { service, error, since });
}

export async function closeHolds(
  ctx: ActionCtx,
  services: HoldService[],
  since: number,
): Promise<void> {
  await ctx.runMutation(internal.serviceHolds.close, { services, since });
}
