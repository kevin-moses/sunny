import { internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import { vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import { createFamilyHousehold, setPhone } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

export const providerMocks = {
  apnsSend: vi.fn(),
  smsSend: vi.fn(),
};

export function resetProviderMocks(): void {
  providerMocks.apnsSend.mockReset();
  providerMocks.apnsSend.mockImplementation(async (args: { tokens: string[] }) =>
    args.tokens.map((token) => ({
      token,
      outcome: "sent",
      status: 200,
      reason: null,
      retryable: false,
    })),
  );
  providerMocks.smsSend.mockReset();
  providerMocks.smsSend.mockResolvedValue({ ok: true, sid: "SM1" });
}

export function apnsModule(original: object = {}) {
  return {
    ...original,
    send: internalActionGeneric({
      args: {
        tokens: v.array(v.string()),
        title: v.string(),
        body: v.string(),
        data: v.optional(v.record(v.string(), v.string())),
        interruptionLevel: v.optional(v.literal("time-sensitive")),
        category: v.optional(v.string()),
      },
      handler: async (_ctx, args) => {
        const reply = await providerMocks.apnsSend(args);
        return Array.isArray(reply) ? { results: reply } : reply;
      },
    }),
  };
}

export function twilioModule(original: object = {}) {
  return {
    ...original,
    sendSmsFromEnv: async (to: string, body: string) => await providerMocks.smsSend({ to, body }),
  };
}

export interface DeliveryFixture {
  t: TestConvex;
  householdId: Id<"households">;
  deviceId: Id<"devices">;
}

export async function deliveryFixture(
  t: TestConvex,
  timezone = "America/New_York",
): Promise<DeliveryFixture> {
  const householdId = await createFamilyHousehold(t, timezone);
  const deviceId = await t.run(async (ctx) => {
    const device = (await ctx.db
      .query("devices")
      .withIndex("by_household", (q) => q.eq("householdId", householdId))
      .first())!;
    await ctx.db.insert("pushTokens", { userId: "phone", token: "tok-1" });
    await ctx.db.insert("pushTokens", { userId: "phone", token: "tok-2" });
    return device._id;
  });
  await setPhone(t, householdId, "pat", "+15550000001");
  await setPhone(t, householdId, "max", "+15550000002");
  await setPhone(t, householdId, "val", "+15550000003", false);
  return { t, householdId, deviceId };
}

export async function insertOutbox(
  f: DeliveryFixture,
  fields: Partial<Doc<"notificationOutbox">> = {},
): Promise<Id<"notificationOutbox">> {
  return await f.t.run(
    async (ctx) =>
      await ctx.db.insert("notificationOutbox", {
        householdId: f.householdId,
        kind: "event_notice",
        state: "pending",
        title: "Title",
        body: "Body",
        payload: {},
        ...fields,
      }),
  );
}

export async function outboxRow(
  f: DeliveryFixture,
  id: Id<"notificationOutbox">,
): Promise<Doc<"notificationOutbox">> {
  return (await f.t.run(async (ctx) => await ctx.db.get(id)))!;
}
