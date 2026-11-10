// convex/lists.test.ts
// Purpose: Tests for the household list: the caregiver and device functions (lists.ts) by role
// (readers read, editors add / untick / remove, editors and devices tick, viewers and devices
// change nothing else), household isolation and by-id ownership, the rules in
// lib/householdList.ts (one line, length cap, open-item cap, case-insensitive duplicates,
// audit rows), the voice agent's functions (agent.addListItems, listItems, tickListItem and the
// context summary), and the digest line for items the senior added that day. The clock is
// frozen.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { gatherDigestFacts } from "./lib/digestFacts";
import { templateDigest } from "./lib/digestText";
import { LIST_CONTEXT_MAX, MAX_LIST_ITEM_LENGTH, MAX_OPEN_LIST_ITEMS } from "./lib/householdList";
import { createFamilyHousehold, createHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

const KEY = "agent-secret-key";
/** Wednesday 2027-03-10 10:00 in New York. */
const NOW = Date.parse("2027-03-10T15:00:00Z");

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.SUNNY_AGENT_KEY;
  process.env.SUNNY_AGENT_KEY = KEY;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  if (savedKey === undefined) delete process.env.SUNNY_AGENT_KEY;
  else process.env.SUNNY_AGENT_KEY = savedKey;
});

/** A family household (Pat primary, Max member, Val viewer, device "phone") and an outsider. */
interface Fixture {
  t: TestConvex;
  householdId: Id<"households">;
  otherId: Id<"households">;
}

/**
 * purpose: Build the fixture: the family household and a second household of user "zed".
 * @return: (Promise<Fixture>) The fixture.
 */
async function setup(): Promise<Fixture> {
  const t = makeBackend();
  const householdId = await createFamilyHousehold(t);
  await t.run(async (ctx) => {
    for (const member of await ctx.db.query("householdMembers").collect()) {
      const name = { pat: "Pat", max: "Max", val: "Val" }[member.userId];
      if (name) await ctx.db.patch(member._id, { displayName: name });
    }
  });
  const otherId = await createHousehold(t, { subject: "zed", seniorName: "Walter" });
  return { t, householdId, otherId };
}

/**
 * purpose: Add an item as a user.
 * @param f: (Fixture) Fixture.
 * @param subject: (string) Who adds.
 * @param text: (string) The item.
 * @param householdId: (Id<"households">, optional) Household; defaults to the family's.
 * @return: (Promise<{status, itemId}>) The result.
 */
async function addAs(f: Fixture, subject: string, text: string, householdId = f.householdId) {
  return await f.t.withIdentity({ subject }).mutation(api.lists.add, { householdId, text });
}

/**
 * purpose: The household's audit rows with a list action.
 * @param f: (Fixture) Fixture.
 * @return: (Promise<Doc<"auditLog">[]>) Rows in order.
 */
async function listAudits(f: Fixture): Promise<Doc<"auditLog">[]> {
  const rows = await f.t.run(async (ctx) => await ctx.db.query("auditLog").collect());
  return rows.filter((r) => r.action.startsWith("list_"));
}

const FORBIDDEN = { data: { code: "forbidden" } };

describe("caregiver and device access", () => {
  test("every caregiver role reads the list; the device sees open items only", async () => {
    const f = await setup();
    const { itemId } = await addAs(f, "pat", "Milk");
    await addAs(f, "max", "Eggs");
    await f.t.withIdentity({ subject: "max" }).mutation(api.lists.tick, { itemId });
    for (const subject of ["pat", "max", "val"]) {
      const list = await f.t
        .withIdentity({ subject })
        .query(api.lists.get, { householdId: f.householdId });
      expect(list.open.map((i) => i.text)).toEqual(["Eggs"]);
      expect(list.done).toMatchObject([
        { text: "Milk", addedByKind: "caregiver", addedByName: "Pat", doneByName: "Max" },
      ]);
    }
    const onDevice = await f.t
      .withIdentity({ subject: "phone" })
      .query(api.lists.get, { householdId: f.householdId });
    expect(onDevice).toMatchObject({ open: [{ text: "Eggs" }], done: [] });
  });

  test("viewers and devices cannot add; outsiders cannot read", async () => {
    const f = await setup();
    await expect(addAs(f, "val", "Milk")).rejects.toMatchObject(FORBIDDEN);
    await expect(addAs(f, "phone", "Milk")).rejects.toMatchObject(FORBIDDEN);
    await expect(
      f.t.withIdentity({ subject: "zed" }).query(api.lists.get, { householdId: f.householdId }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  test("editors and the device tick; viewers cannot", async () => {
    const f = await setup();
    const milk = (await addAs(f, "pat", "Milk")).itemId;
    const eggs = (await addAs(f, "pat", "Eggs")).itemId;
    await expect(
      f.t.withIdentity({ subject: "val" }).mutation(api.lists.tick, { itemId: milk }),
    ).rejects.toMatchObject(FORBIDDEN);
    const byDevice = await f.t
      .withIdentity({ subject: "phone" })
      .mutation(api.lists.tick, { itemId: milk });
    expect(byDevice).toMatchObject({ doneByKind: "senior", doneByName: null });
    expect(byDevice.doneAt).toBeGreaterThanOrEqual(NOW);
    const byEditor = await f.t
      .withIdentity({ subject: "max" })
      .mutation(api.lists.tick, { itemId: eggs });
    expect(byEditor).toMatchObject({ doneByKind: "caregiver", doneByName: "Max" });
  });

  test("untick and remove are editors only", async () => {
    const f = await setup();
    const { itemId } = await addAs(f, "pat", "Milk");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.lists.tick, { itemId });
    for (const subject of ["val", "phone"]) {
      await expect(
        f.t.withIdentity({ subject }).mutation(api.lists.untick, { itemId }),
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        f.t.withIdentity({ subject }).mutation(api.lists.remove, { itemId }),
      ).rejects.toMatchObject(FORBIDDEN);
    }
    const reopened = await f.t.withIdentity({ subject: "max" }).mutation(api.lists.untick, {
      itemId,
    });
    expect(reopened).toMatchObject({ doneAt: null, doneByKind: null });
    await f.t.withIdentity({ subject: "max" }).mutation(api.lists.remove, { itemId });
    expect(await f.t.run(async (ctx) => await ctx.db.get(itemId))).toBeNull();
    expect((await listAudits(f)).map((a) => a.action)).toEqual([
      "list_add",
      "list_done",
      "list_undone",
      "list_remove",
    ]);
  });

  test("an item id from another household is forbidden for every change", async () => {
    const f = await setup();
    const theirs = (await addAs(f, "zed", "Bread", f.otherId)).itemId;
    for (const fn of [api.lists.tick, api.lists.untick, api.lists.remove]) {
      for (const subject of ["pat", "phone"]) {
        await expect(
          f.t.withIdentity({ subject }).mutation(fn, { itemId: theirs }),
        ).rejects.toMatchObject(FORBIDDEN);
      }
    }
    const item = await f.t.run(async (ctx) => await ctx.db.get(theirs));
    expect(item!.doneAt).toBeUndefined();
  });

  test("a missing item is not_found", async () => {
    const f = await setup();
    const { itemId } = await addAs(f, "pat", "Milk");
    await f.t.run(async (ctx) => await ctx.db.delete(itemId));
    await expect(
      f.t.withIdentity({ subject: "pat" }).mutation(api.lists.tick, { itemId }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});

describe("list rules", () => {
  test("text is one trimmed line; blank and over-long are invalid", async () => {
    const f = await setup();
    const { itemId } = await addAs(f, "pat", "  Whole\n milk ");
    expect((await f.t.run(async (ctx) => await ctx.db.get(itemId)))!.text).toBe("Whole milk");
    const INVALID = { data: { code: "invalid" } };
    await expect(addAs(f, "pat", " \n ")).rejects.toMatchObject(INVALID);
    await expect(addAs(f, "pat", "x".repeat(MAX_LIST_ITEM_LENGTH + 1))).rejects.toMatchObject(
      INVALID,
    );
  });

  test("an item already open is not added again, whatever its case or spacing", async () => {
    const f = await setup();
    const first = await addAs(f, "pat", "Whole milk");
    expect(await addAs(f, "max", "whole   MILK")).toEqual({
      status: "already_on_list",
      itemId: first.itemId,
    });
    // Once ticked it can be added again.
    await f.t.withIdentity({ subject: "pat" }).mutation(api.lists.tick, { itemId: first.itemId });
    expect((await addAs(f, "pat", "Whole milk")).status).toBe("added");
  });

  test("the open list is capped; unticking past the cap or onto a duplicate is refused", async () => {
    const f = await setup();
    const first = await addAs(f, "pat", "item 0");
    await f.t.withIdentity({ subject: "pat" }).mutation(api.lists.tick, { itemId: first.itemId });
    for (let i = 1; i <= MAX_OPEN_LIST_ITEMS; i++) await addAs(f, "pat", `item ${i}`);
    await expect(addAs(f, "pat", "one more")).rejects.toMatchObject({ data: { code: "limit" } });
    await expect(
      f.t.withIdentity({ subject: "pat" }).mutation(api.lists.untick, { itemId: first.itemId }),
    ).rejects.toMatchObject({ data: { code: "limit" } });
  });
});

describe("voice agent list functions", () => {
  test("adds several items at once, skips ones already there, and reads the list", async () => {
    const f = await setup();
    await addAs(f, "pat", "Eggs");
    const added = await f.t.mutation(api.agent.addListItems, {
      agentKey: KEY,
      householdId: f.householdId,
      items: ["milk", "eggs", "Milk", " "],
    });
    expect(added.map((a) => [a.text, a.status])).toEqual([
      ["milk", "added"],
      ["eggs", "already_on_list"],
    ]);
    const row = await f.t.run(async (ctx) => await ctx.db.get(added[0]!.itemId!));
    expect(row).toMatchObject({ addedByKind: "senior" });
    expect(row!.addedAt).toBeGreaterThanOrEqual(NOW);
    expect(row!.addedBy).toBeUndefined();
    expect(
      await f.t.query(api.agent.listItems, { agentKey: KEY, householdId: f.householdId }),
    ).toEqual(["Eggs", "milk"]);
  });

  test("a full list reports list_full for the rest", async () => {
    const f = await setup();
    const items = Array.from({ length: MAX_OPEN_LIST_ITEMS - 1 }, (_, i) => `thing ${i}`);
    await f.t.run(async (ctx) => {
      for (const text of items) {
        await ctx.db.insert("listItems", {
          householdId: f.householdId,
          text,
          addedByKind: "caregiver",
          addedAt: NOW,
        });
      }
    });
    const result = await f.t.mutation(api.agent.addListItems, {
      agentKey: KEY,
      householdId: f.householdId,
      items: ["milk", "bread"],
    });
    expect(result.map((r) => r.status)).toEqual(["added", "list_full"]);
  });

  test("ticks the item the words mean; ambiguous and not found change nothing", async () => {
    const f = await setup();
    await f.t.mutation(api.agent.addListItems, {
      agentKey: KEY,
      householdId: f.householdId,
      items: ["whole milk", "oat milk", "bread"],
    });
    /**
     * purpose: Tick by words.
     * @param item: (string) The words.
     * @return: (Promise<object>) The result.
     */
    const tick = (item: string) =>
      f.t.mutation(api.agent.tickListItem, { agentKey: KEY, householdId: f.householdId, item });
    expect(await tick("milk")).toEqual({
      status: "ambiguous",
      text: null,
      options: ["whole milk", "oat milk"],
    });
    expect(await tick("the bread")).toEqual({ status: "ticked", text: "bread", options: [] });
    expect(await tick("bread")).toEqual({ status: "not_found", text: null, options: [] });
    expect(await tick("Oat Milk")).toMatchObject({ status: "ticked", text: "oat milk" });
    const audits = await listAudits(f);
    expect(audits.filter((a) => a.action === "list_done")).toHaveLength(2);
    expect(audits.every((a) => a.actorKind === "agent")).toBe(true);
  });

  test("another household's items are never read or ticked", async () => {
    const f = await setup();
    await addAs(f, "zed", "Bread", f.otherId);
    expect(
      await f.t.query(api.agent.listItems, { agentKey: KEY, householdId: f.householdId }),
    ).toEqual([]);
    expect(
      (
        await f.t.mutation(api.agent.tickListItem, {
          agentKey: KEY,
          householdId: f.householdId,
          item: "bread",
        })
      ).status,
    ).toBe("not_found");
  });

  test("the context lists a short list and only counts a long one", async () => {
    const f = await setup();
    /**
     * purpose: The context's list summary.
     * @return: (Promise<object>) The summary.
     */
    const summary = async () =>
      (await f.t.query(api.agent.getContext, { agentKey: KEY, householdId: f.householdId })).list;
    await f.t.mutation(api.agent.addListItems, {
      agentKey: KEY,
      householdId: f.householdId,
      items: ["milk", "eggs"],
    });
    expect(await summary()).toEqual({ openCount: 2, items: ["milk", "eggs"] });
    await f.t.mutation(api.agent.addListItems, {
      agentKey: KEY,
      householdId: f.householdId,
      items: Array.from({ length: LIST_CONTEXT_MAX }, (_, i) => `thing ${i}`),
    });
    expect(await summary()).toEqual({ openCount: LIST_CONTEXT_MAX + 2, items: [] });
  });
});

describe("digest line", () => {
  test("items the senior added that day get one line; caregivers' items do not", async () => {
    const f = await setup();
    await f.t.mutation(api.agent.addListItems, {
      agentKey: KEY,
      householdId: f.householdId,
      items: ["milk", "eggs"],
    });
    await addAs(f, "pat", "Light bulbs");
    const facts = await f.t.run(async (ctx) =>
      gatherDigestFacts(ctx, (await ctx.db.get(f.householdId))!, "2027-03-10"),
    );
    expect(facts.listAdded).toEqual(["milk", "eggs"]);
    expect(templateDigest(facts)).toBe("Added to the list: milk; eggs.");
    const nextDay = await f.t.run(async (ctx) =>
      gatherDigestFacts(ctx, (await ctx.db.get(f.householdId))!, "2027-03-11"),
    );
    expect(nextDay.listAdded).toEqual([]);
  });
});
