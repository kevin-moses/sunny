import { v } from "convex/values";
import type { Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MINUTE_MS } from "./time";

export const holdService = v.union(v.literal("gmail"), v.literal("calendar"), v.literal("jev"));

export type HoldService = Infer<typeof holdService>;

const holdState = {
  open: v.boolean(),
  since: v.number(),
  error: v.string(),
  openedAt: v.number(),
  probeAt: v.number(),
  closedAt: v.optional(v.number()),
};

export const serviceHoldRow = v.union(
  v.object({ service: v.literal("calendar"), ...holdState }),
  v.object({
    service: v.union(v.literal("gmail"), v.literal("jev")),
    ...holdState,
    mailHeldSince: v.number(),
  }),
);

export type OpenedHold = Omit<Infer<typeof serviceHoldRow>, "service" | "mailHeldSince">;

export function holdRow(
  service: HoldService,
  opened: OpenedHold,
  mailHeldSince: number,
): Infer<typeof serviceHoldRow> {
  if (service === "calendar") return { service, ...opened };
  return { service, ...opened, mailHeldSince };
}

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
  const since = (await openHolds(ctx, MAIL_SERVICES)).flatMap((hold) =>
    hold.service === "calendar" ? [] : [hold.mailHeldSince],
  );
  return since.length === 0 ? null : Math.min(...since);
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
