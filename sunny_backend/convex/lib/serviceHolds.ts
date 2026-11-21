import { v } from "convex/values";
import type { Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MINUTE_MS } from "./time";

export const holdService = v.union(v.literal("gmail"), v.literal("calendar"), v.literal("jev"));

export type HoldService = Infer<typeof holdService>;

export type HoldGate = "free" | "held" | "probe";

export const MAIL_SERVICES: readonly HoldService[] = ["gmail", "jev"];

export const PROBE_EVERY_MS = 15 * MINUTE_MS;

export async function holdOf(
  ctx: QueryCtx,
  service: HoldService,
): Promise<Doc<"serviceHolds"> | null> {
  return await ctx.db
    .query("serviceHolds")
    .withIndex("by_service", (q) => q.eq("service", service))
    .unique();
}

async function openHolds(
  ctx: QueryCtx,
  services: readonly HoldService[],
): Promise<Doc<"serviceHolds">[]> {
  const holds = await Promise.all(services.map((service) => holdOf(ctx, service)));
  return holds.filter((hold): hold is Doc<"serviceHolds"> => hold?.open === true);
}

function gateOf(open: Doc<"serviceHolds">[], now: number): HoldGate {
  if (open.length === 0) return "free";
  return open.every((hold) => hold.probeAt <= now) ? "probe" : "held";
}

export async function holdGate(
  ctx: QueryCtx,
  services: readonly HoldService[],
  now: number,
): Promise<HoldGate> {
  return gateOf(await openHolds(ctx, services), now);
}

export async function mailHeldSince(ctx: QueryCtx): Promise<number | null> {
  const open = await openHolds(ctx, MAIL_SERVICES);
  if (open.length === 0) return null;
  return Math.min(...open.map((hold) => hold.mailHeldSince ?? hold.openedAt));
}

export async function enterGate(
  ctx: MutationCtx,
  services: readonly HoldService[],
  now: number,
): Promise<HoldGate> {
  const open = await openHolds(ctx, services);
  const gate = gateOf(open, now);
  if (gate === "probe") {
    for (const hold of open) await ctx.db.patch(hold._id, { probeAt: now + PROBE_EVERY_MS });
  }
  return gate;
}

export async function rearmProbes(
  ctx: MutationCtx,
  services: readonly HoldService[],
  since: number,
  now: number,
): Promise<HoldService[]> {
  const rearmed: HoldService[] = [];
  for (const hold of await openHolds(ctx, services)) {
    if (hold.openedAt > since) continue;
    await ctx.db.patch(hold._id, { probeAt: now });
    rearmed.push(hold.service);
  }
  return rearmed;
}
