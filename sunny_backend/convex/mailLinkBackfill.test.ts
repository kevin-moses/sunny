import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createFamilyHousehold, insertEvent, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

interface Household {
  t: TestConvex;
  householdId: Id<"households">;
  eventId: Id<"events">;
}

async function household(): Promise<Household> {
  const t = makeBackend();
  const householdId = await createFamilyHousehold(t);
  const eventId = await insertEvent(t, householdId, {
    title: "Eye exam",
    startsOn: "2026-12-10",
    startTime: "14:15",
  });
  return { t, householdId, eventId };
}

async function mailItem(h: Household, gmailId: string, address: string | null) {
  return await h.t.run(
    async (ctx) =>
      await ctx.db.insert("mailItems", {
        householdId: h.householdId,
        account: "mom@example.com",
        gmailId,
        state: "done",
        attempt: 1,
        ...(address === null
          ? {}
          : {
              sender: { name: "Clinic", address, authenticated: true },
              subject: "Your visit",
              receivedAt: 0,
            }),
      }),
  );
}

async function link(
  h: Household,
  key: string,
  mailItemId: Id<"mailItems">,
  senderAddress?: string,
): Promise<Id<"mailEventLinks">> {
  return await h.t.run(
    async (ctx) =>
      await ctx.db.insert("mailEventLinks", {
        householdId: h.householdId,
        eventId: h.eventId,
        appointmentKey: key,
        senderDomain: "clinic.example",
        mailItemId,
        ...(senderAddress === undefined ? {} : { senderAddress }),
      }),
  );
}

async function links(h: Household) {
  return await h.t.run(async (ctx) => await ctx.db.query("mailEventLinks").collect());
}

async function backfillAll(h: Household): Promise<{ backfilled: number; deleted: number }> {
  let cursor: string | null = null;
  let backfilled = 0;
  let deleted = 0;
  for (;;) {
    const page: { backfilled: number; deleted: number; isDone: boolean; continueCursor: string } =
      await h.t.mutation(internal.mailLinkBackfill.backfillSenderAddress, { cursor });
    backfilled += page.backfilled;
    deleted += page.deleted;
    if (page.isDone) return { backfilled, deleted };
    cursor = page.continueCursor;
  }
}

describe("backfillSenderAddress", () => {
  test("copies the address from the link's email, deletes a link whose email is gone and keeps a stored address", async () => {
    const h = await household();
    const fromClinic = await mailItem(h, "m1", "front@clinic.example");
    const gone = await mailItem(h, "m2", "old@clinic.example");
    const stored = await mailItem(h, "m3", "front@clinic.example");
    const backfilled = await link(h, "ics:a", fromClinic);
    await link(h, "ics:b", gone);
    const kept = await link(h, "ics:c", stored, "desk@clinic.example");
    await h.t.run(async (ctx) => await ctx.db.delete(gone));

    expect(await backfillAll(h)).toEqual({ backfilled: 1, deleted: 1 });
    const after = await links(h);
    expect(after.map((l) => [l._id, l.senderAddress])).toEqual([
      [backfilled, "front@clinic.example"],
      [kept, "desk@clinic.example"],
    ]);
  });

  test("deletes a link whose email never had a sender stored", async () => {
    const h = await household();
    await link(h, "ics:a", await mailItem(h, "m1", null));
    expect(await backfillAll(h)).toEqual({ backfilled: 0, deleted: 1 });
    expect(await links(h)).toEqual([]);
  });

  test("a second run changes nothing", async () => {
    const h = await household();
    await link(h, "ics:a", await mailItem(h, "m1", "front@clinic.example"));
    await backfillAll(h);
    const before = await links(h);
    expect(await backfillAll(h)).toEqual({ backfilled: 0, deleted: 0 });
    expect(await links(h)).toEqual(before);
  });

  test("walks every page", async () => {
    const h = await household();
    const itemId = await mailItem(h, "m1", "front@clinic.example");
    for (let i = 0; i < 205; i += 1) await link(h, `ics:${i}`, itemId);
    const first = await h.t.mutation(internal.mailLinkBackfill.backfillSenderAddress, {
      cursor: null,
    });
    expect(first).toMatchObject({ backfilled: 200, isDone: false });
    expect(await backfillAll(h)).toEqual({ backfilled: 5, deleted: 0 });
    expect((await links(h)).every((l) => l.senderAddress === "front@clinic.example")).toBe(true);
  });
});
