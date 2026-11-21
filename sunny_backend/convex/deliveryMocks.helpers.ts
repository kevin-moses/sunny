import { internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import { vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import type { ApnsResult, ApnsSendResult } from "./lib/apnsPayload";
import { apnsMessage } from "./lib/validators";
import type { ApnsMessage } from "./lib/validators";
import { createFamilyHousehold, setPhone } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

export interface ApnsSendArgs {
  sends: { token: string; message: ApnsMessage }[];
}

export const providerMocks = {
  apnsSend: vi.fn<(args: ApnsSendArgs) => Promise<ApnsResult[] | ApnsSendResult>>(),
  smsSend: vi.fn(),
};

export interface SentPush {
  tokens: string[];
  message: ApnsMessage;
  payload: Record<string, unknown>;
}

export interface SentAlert {
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, unknown>;
  interruptionLevel?: string;
  category?: string;
}

interface AlertAps {
  alert: { title: string; body: string };
  "interruption-level"?: string;
  category?: string;
}

export const APNS_SENT: Omit<ApnsResult, "token"> = {
  outcome: "sent",
  status: 200,
  reason: null,
  retryable: false,
};

export function answerEachToken(answer: (token: string) => Omit<ApnsResult, "token">): void {
  providerMocks.apnsSend.mockImplementation(async (args: ApnsSendArgs) =>
    args.sends.map(({ token }) => ({ token, ...answer(token) })),
  );
}

export function pushesSent(): SentPush[] {
  return providerMocks.apnsSend.mock.calls.flatMap(([args]) => {
    const first = args.sends[0];
    if (first === undefined) return [];
    return [
      {
        tokens: args.sends.map((send) => send.token),
        message: first.message,
        payload: JSON.parse(first.message.body) as Record<string, unknown>,
      },
    ];
  });
}

export function alertsSent(): SentAlert[] {
  return pushesSent()
    .filter((push) => push.message.pushType === "alert")
    .map(({ tokens, payload }) => {
      const { aps, ...data } = payload as { aps: AlertAps } & Record<string, unknown>;
      const alert: SentAlert = { tokens, title: aps.alert.title, body: aps.alert.body, data };
      if (aps["interruption-level"] !== undefined) {
        alert.interruptionLevel = aps["interruption-level"];
      }
      if (aps.category !== undefined) alert.category = aps.category;
      return alert;
    });
}

export function resetProviderMocks(): void {
  providerMocks.apnsSend.mockReset();
  answerEachToken(() => APNS_SENT);
  providerMocks.smsSend.mockReset();
  providerMocks.smsSend.mockResolvedValue({ ok: true, sid: "SM1" });
}

export function apnsModule(original: object = {}) {
  return {
    ...original,
    send: internalActionGeneric({
      args: { sends: v.array(v.object({ token: v.string(), message: apnsMessage })) },
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
