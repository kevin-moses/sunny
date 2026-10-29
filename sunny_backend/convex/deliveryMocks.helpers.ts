// deliveryMocks.helpers.ts
// Purpose: Shared vitest mocks and fixtures for the delivery and digest tests
// (delivery.test.ts, digest.test.ts), so APNs, SMS and the model are never called. Test files
// register the module mocks with vi.mock, whose factories import from here:
//   vi.mock("./apns", async () => (await import("./deliveryMocks.helpers")).apnsModule());
//   vi.mock("./sms", async () => (await import("./deliveryMocks.helpers")).smsModule());
// The fixture helpers build a household (Pat primary, Max member, Val viewer, one paired
// device "phone") with push tokens and verified phones, and insert outbox rows directly.
// The name has two dots, so Convex does not treat this file as a function module.
//
// Last modified: 2026-10-29

import { internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import { vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import { createFamilyHousehold, setPhone } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

/** The mocked providers, shared by the test file and the mocked modules. */
export const providerMocks = {
  apnsSend: vi.fn(),
  smsSend: vi.fn(),
};

/**
 * purpose: Reset the provider mocks to their default behaviour: every token and message sent.
 * @return: (void)
 */
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

/**
 * purpose: The ./apns module with send replaced by the mock.
 * @return: (object) The mocked module.
 */
export function apnsModule(original: object = {}) {
  return {
    ...original,
    send: internalActionGeneric({
      args: {
        tokens: v.array(v.string()),
        title: v.string(),
        body: v.string(),
        data: v.optional(v.record(v.string(), v.string())),
      },
      handler: async (_ctx, args) => {
        // Tests may script a bare per-token array or a full { results, configError }.
        const reply = await providerMocks.apnsSend(args);
        return Array.isArray(reply) ? { results: reply } : reply;
      },
    }),
  };
}

/**
 * purpose: The ./sms module with send replaced by the mock.
 * @return: (object) The mocked module.
 */
export function smsModule(original: object = {}) {
  return {
    ...original,
    send: internalActionGeneric({
      args: { to: v.string(), body: v.string() },
      handler: async (_ctx, args) => await providerMocks.smsSend(args),
    }),
  };
}

/** A household with its paired device, for delivery tests. */
export interface DeliveryFixture {
  t: TestConvex;
  householdId: Id<"households">;
  deviceId: Id<"devices">;
}

/**
 * purpose: A family household with push tokens for the device's user ("phone") and verified
 *          phones for Pat and Max (Val has a phone that is not verified).
 * @param t: (TestConvex) Harness.
 * @param timezone: (string) IANA zone of the household.
 * @return: (Promise<DeliveryFixture>) The fixture.
 */
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

/**
 * purpose: Insert an outbox row directly (no delivery is enqueued).
 * @param f: (DeliveryFixture) Fixture.
 * @param fields: (Partial<Doc<"notificationOutbox">>) Overrides.
 * @return: (Promise<Id<"notificationOutbox">>) The row.
 */
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

/**
 * purpose: Read an outbox row.
 * @param f: (DeliveryFixture) Fixture.
 * @param id: (Id<"notificationOutbox">) The row.
 * @return: (Promise<Doc<"notificationOutbox">>) The row.
 */
export async function outboxRow(
  f: DeliveryFixture,
  id: Id<"notificationOutbox">,
): Promise<Doc<"notificationOutbox">> {
  return (await f.t.run(async (ctx) => await ctx.db.get(id)))!;
}
