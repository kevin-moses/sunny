import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { executeAgentTool } from "./lib/agentTools";
import {
  createFamilyHousehold,
  createHousehold,
  insertRequest,
  makeBackend,
} from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

const NOW = Date.parse("2026-11-18T14:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const HELD_FOR_TRUST: Doc<"mailItems">["effects"] = [
  { kind: "escalated", reason: "new_sender", pushed: true, senderNotTrusted: true },
];

async function mailItem(
  t: TestConvex,
  householdId: Id<"households">,
  address = "Frontdesk@NorthsideFoot.example",
  fields: Partial<Doc<"mailItems">> & { authenticated?: boolean } = {},
): Promise<Id<"mailItems">> {
  const { authenticated = true, ...rest } = fields;
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("mailItems", {
        householdId,
        account: "mom@example.com",
        gmailId: `g-${address}-${Math.random()}`,
        state: "done",
        attempt: 1,
        sender: { name: "Northside Foot & Ankle", address, authenticated },
        subject: "Appointment with Dr. Nwosu",
        receivedAt: NOW - 60_000,
        verdict: "appointment",
        effects: HELD_FOR_TRUST,
        ...rest,
      }),
  );
}

async function runTools(
  t: TestConvex,
  requestId: Id<"agentRequests">,
  calls: Array<[string, string, Record<string, unknown>]>,
): Promise<unknown> {
  return await t.mutation(internal.agentRuntime.executeToolCalls, {
    requestId,
    calls: calls.map(([toolUseId, name, input]) => ({
      toolUseId,
      name,
      input: JSON.stringify(input),
    })),
  });
}

async function toolText(t: TestConvex, requestId: Id<"agentRequests">, toolUseId: string) {
  const [result] = await t.query(internal.agentRuntime.storedResults, {
    requestId,
    toolUseIds: [toolUseId],
  });
  return result!;
}

async function all<T extends "mailTrustedSenders" | "auditLog">(
  t: TestConvex,
  table: T,
): Promise<Doc<T>[]> {
  return await t.run(async (ctx) => await ctx.db.query(table).collect());
}

async function trustAudits(t: TestConvex): Promise<Doc<"auditLog">[]> {
  return (await all(t, "auditLog")).filter((r) => r.entity === "mailTrustedSender");
}

describe("trust_mail_sender", () => {
  test("trusts the exact sender address of an email from Sunny's records, once, with an audit row", async () => {
    const t = makeBackend();
    const home = await createFamilyHousehold(t);
    const itemId = await mailItem(t, home);
    const requestId = await insertRequest(t, home, { requestedBy: "max", status: "running" });
    const call: [string, string, Record<string, unknown>] = [
      "tu1",
      "trust_mail_sender",
      { mail_item_id: itemId },
    ];

    await runTools(t, requestId, [call]);
    await runTools(t, requestId, [call]);

    const rows = await all(t, "mailTrustedSenders");
    expect(rows).toMatchObject([
      {
        householdId: home,
        address: "frontdesk@northsidefoot.example",
        addedBy: "max",
        mailItemId: itemId,
      },
    ]);
    const audits = await trustAudits(t);
    expect(audits).toMatchObject([
      {
        actorKind: "agent",
        actorUserId: "max",
        action: "trust",
        entityId: rows[0]!._id,
        detail: { address: "frontdesk@northsidefoot.example", mailItemId: itemId, requestId },
      },
    ]);
    const result = await toolText(t, requestId, "tu1");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      status: "trusted",
      trusted_sender: {
        trusted_sender_id: rows[0]!._id,
        address: "frontdesk@northsidefoot.example",
        added_on: "2026-11-18",
      },
    });
  });

  test("trusting the same address again changes nothing and says so", async () => {
    const t = makeBackend();
    const home = await createFamilyHousehold(t);
    const itemId = await mailItem(t, home);
    const requestId = await insertRequest(t, home, { requestedBy: "pat", status: "running" });
    await runTools(t, requestId, [
      ["tu1", "trust_mail_sender", { mail_item_id: itemId }],
      ["tu2", "trust_mail_sender", { mail_item_id: itemId }],
    ]);
    expect(await all(t, "mailTrustedSenders")).toHaveLength(1);
    expect(await trustAudits(t)).toHaveLength(1);
    expect(JSON.parse((await toolText(t, requestId, "tu2")).text)).toMatchObject({
      status: "already_trusted",
    });
  });

  test("a viewer's request trusts nothing", async () => {
    const t = makeBackend();
    const home = await createFamilyHousehold(t);
    const itemId = await mailItem(t, home);
    const requestId = await insertRequest(t, home, { requestedBy: "val", status: "running" });
    expect(
      await runTools(t, requestId, [["tu1", "trust_mail_sender", { mail_item_id: itemId }]]),
    ).toMatchObject({ kind: "failed" });
    expect(await all(t, "mailTrustedSenders")).toHaveLength(0);
    expect(await trustAudits(t)).toHaveLength(0);
  });

  test("takes no address from the model and no email of another household", async () => {
    const t = makeBackend();
    const home = await createFamilyHousehold(t);
    const other = await createHousehold(t, { subject: "ben", caregiverName: "Ben" });
    const foreign = await mailItem(t, other, "scam@evil.example");
    const actor = { kind: "agent", onBehalfOf: "pat" } as const;
    const run = async (input: Record<string, unknown>) =>
      await t.run(
        async (ctx) =>
          await executeAgentTool(
            ctx,
            { householdId: home, actor, now: NOW },
            { name: "trust_mail_sender", input },
          ),
      );
    expect(await run({ mail_item_id: foreign })).toEqual({
      text: "Error: Email not found",
      isError: true,
    });
    expect(await run({ mail_item_id: foreign, address: "scam@evil.example" })).toEqual({
      text: "Error: Unknown field address",
      isError: true,
    });
    expect(await run({ mail_item_id: "scam@evil.example" })).toMatchObject({ isError: true });
    expect(await all(t, "mailTrustedSenders")).toHaveLength(0);
  });
});

describe("what trust_mail_sender refuses", () => {
  async function trust(
    fields: Parameters<typeof mailItem>[3],
  ): Promise<{ text: string; isError: boolean }> {
    const t = makeBackend();
    const home = await createFamilyHousehold(t);
    const itemId = await mailItem(t, home, "x@clinic.example", fields);
    const result = await t.run(
      async (ctx) =>
        await executeAgentTool(
          ctx,
          { householdId: home, actor: { kind: "agent", onBehalfOf: "pat" }, now: NOW },
          { name: "trust_mail_sender", input: { mail_item_id: itemId } },
        ),
    );
    expect(await all(t, "mailTrustedSenders")).toHaveLength(result.isError ? 0 : 1);
    return result;
  }

  test.each([
    [
      "a sender Gmail did not verify",
      {
        authenticated: false,
        effects: [
          { kind: "escalated" as const, reason: "unverified_sender" as const, pushed: true },
        ],
      },
      "Error: Gmail did not verify the sender of that email, so Sunny cannot trust it",
    ],
    [
      "an email Sunny thinks may be a scam",
      {
        verdict: "suspicious" as const,
        effects: [{ kind: "escalated" as const, reason: "money_request" as const, pushed: true }],
      },
      "Error: Sunny thinks that email may be a scam, so it will not trust its sender",
    ],
    [
      "an email Sunny held nothing back from",
      { effects: [{ kind: "told_caregivers" as const, pushed: false }] },
      "Error: Sunny held nothing back from that email for want of trust, so there is nothing to trust its sender for",
    ],
    [
      "an email that escalated for another reason",
      { effects: [{ kind: "escalated" as const, reason: "conflict" as const, pushed: true }] },
      "Error: Sunny held nothing back from that email for want of trust, so there is nothing to trust its sender for",
    ],
  ])("%s", async (_, fields, text) => {
    expect(await trust(fields)).toEqual({ text, isError: true });
  });

  test.each([
    [
      "a reschedule held back for an untrusted sender",
      {
        effects: [
          {
            kind: "escalated" as const,
            reason: "unclear_reschedule" as const,
            pushed: true,
            senderNotTrusted: true as const,
          },
        ],
      },
    ],
    [
      "news for the senior told only to the caregivers",
      {
        verdict: "senior_info" as const,
        effects: [
          { kind: "told_caregivers" as const, pushed: false, senderNotTrusted: true as const },
        ],
      },
    ],
  ])("accepts %s", async (_, fields) => {
    expect(await trust(fields)).toMatchObject({ isError: false });
  });
});

describe("list_trusted_mail_senders and untrust_mail_sender", () => {
  test("list what is trusted and remove one sender, with an audit row", async () => {
    const t = makeBackend();
    const home = await createFamilyHousehold(t);
    const itemId = await mailItem(t, home);
    const requestId = await insertRequest(t, home, { requestedBy: "pat", status: "running" });
    await runTools(t, requestId, [
      ["tu1", "trust_mail_sender", { mail_item_id: itemId }],
      ["tu2", "list_trusted_mail_senders", {}],
    ]);
    const [row] = await all(t, "mailTrustedSenders");
    expect(JSON.parse((await toolText(t, requestId, "tu2")).text)).toEqual({
      trusted_senders: [
        {
          trusted_sender_id: row!._id,
          address: "frontdesk@northsidefoot.example",
          added_on: "2026-11-18",
        },
      ],
    });

    await runTools(t, requestId, [
      ["tu3", "untrust_mail_sender", { trusted_sender_id: row!._id }],
      ["tu4", "list_trusted_mail_senders", {}],
    ]);
    expect(await all(t, "mailTrustedSenders")).toHaveLength(0);
    expect(JSON.parse((await toolText(t, requestId, "tu3")).text)).toMatchObject({
      removed: { address: "frontdesk@northsidefoot.example" },
    });
    expect(JSON.parse((await toolText(t, requestId, "tu4")).text)).toEqual({
      trusted_senders: [],
    });
    expect((await trustAudits(t)).map((a) => [a.action, a.actorUserId])).toEqual([
      ["trust", "pat"],
      ["untrust", "pat"],
    ]);
    const posts = await t.run(async (ctx) => await ctx.db.query("chatPosts").collect());
    expect(posts.map((p) => [p.kind, p.body])).toEqual([
      ["mailbox", "Pat told Sunny to trust mail from frontdesk@northsidefoot.example."],
      ["mailbox", "Pat told Sunny to stop trusting mail from frontdesk@northsidefoot.example."],
    ]);
  });
});
