// convex/profile.test.ts
// Purpose: Tests for profile.ts with convex-test and a fake clock. Covers, for every public
// function: access by role (primary and member write; viewers and the paired device only read,
// and the device cannot read the sensitive-topic playbook; signed-out callers and caregivers of
// another household are refused), household isolation (a row id from household A is not found
// through household B, and B's caregiver cannot act in A), text cleaning and length caps, count
// caps, duplicate handling (adds return the existing row, renames onto a taken key are refused),
// one audit row per change and none for a no-op, the memory rule (caregiver facts are verified
// at once; a senior-stated fact is verified only by an editor; the first verifier is kept; a
// correction verifies and keeps the source; adding a fact the senior already stated verifies it)
// and the message list (newest first, senior messages included, seen state, local time, limit).
// Also checks that what is written is what agent.getContext gives the voice agent, including
// that every verified fact fits its 50-fact window.
//
// Last modified: 2026-11-09

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  MAX_DETAILS,
  MAX_ENTRIES,
  MAX_FACT,
  MAX_GUIDANCE,
  MAX_MESSAGE,
  MAX_NAME,
  MAX_TOPIC,
  MAX_TOPICS,
  MAX_VERIFIED_FACTS,
} from "./profile";
import { createFamilyHousehold, createHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

/** Wednesday 2027-03-10 10:00 in New York (EST). */
const NOW = Date.parse("2027-03-10T15:00:00Z");
const AGENT_KEY = "profile-test-agent-key";

/** A caller: the harness with an identity. */
type Caller = ReturnType<TestConvex["withIdentity"]>;

/**
 * The family household (Pat primary, Max member, Val viewer, a paired phone) and an outsider.
 * The convex-test clock moves on by about a millisecond per call, so instants written by a
 * call are compared with expect.any or a range rather than exactly.
 */
interface World {
  t: TestConvex;
  householdId: Id<"households">;
  otherHouseholdId: Id<"households">;
  pat: Caller;
  max: Caller;
  val: Caller;
  phone: Caller;
  outsider: Caller;
}

let savedKey: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  savedKey = process.env.SUNNY_AGENT_KEY;
  process.env.SUNNY_AGENT_KEY = AGENT_KEY;
});

afterEach(() => {
  vi.useRealTimers();
  if (savedKey === undefined) delete process.env.SUNNY_AGENT_KEY;
  else process.env.SUNNY_AGENT_KEY = savedKey;
});

/**
 * purpose: Build the family household and a second household owned by the outsider.
 * @return: (Promise<World>) The world.
 */
async function setup(): Promise<World> {
  const t = makeBackend();
  const householdId = await createFamilyHousehold(t);
  const otherHouseholdId = await createHousehold(t, { subject: "outsider", seniorName: "Ruth" });
  await t.run(async (ctx) => {
    const member = await ctx.db
      .query("householdMembers")
      .withIndex("by_household_user", (q) => q.eq("householdId", householdId).eq("userId", "max"))
      .unique();
    await ctx.db.patch(member!._id, { displayName: "Max" });
  });
  return {
    t,
    householdId,
    otherHouseholdId,
    pat: t.withIdentity({ subject: "pat" }),
    max: t.withIdentity({ subject: "max" }),
    val: t.withIdentity({ subject: "val" }),
    phone: t.withIdentity({ subject: "phone" }),
    outsider: t.withIdentity({ subject: "outsider" }),
  };
}

/**
 * purpose: The audit rows of a household for one entity type, oldest first.
 * @param w: (World) The world.
 * @param entity: (string) Entity name, for example "lifeProfileEntry".
 * @return: (Promise<Doc<"auditLog">[]>) The rows.
 */
async function auditRows(w: World, entity: string): Promise<Doc<"auditLog">[]> {
  return await w.t.run(async (ctx) =>
    (
      await ctx.db
        .query("auditLog")
        .withIndex("by_household", (q) => q.eq("householdId", w.householdId))
        .collect()
    ).filter((r) => r.entity === entity),
  );
}

/**
 * purpose: Insert a memory fact directly, as the voice agent or a test fixture would.
 * @param w: (World) The world.
 * @param fact: (string) The text.
 * @param fields: (Partial<Doc<"agentMemory">>) Overrides; default an unverified senior fact.
 * @return: (Promise<Id<"agentMemory">>) The fact.
 */
async function insertFact(
  w: World,
  fact: string,
  fields: Partial<Doc<"agentMemory">> = {},
): Promise<Id<"agentMemory">> {
  return await w.t.run(
    async (ctx) =>
      await ctx.db.insert("agentMemory", {
        householdId: w.householdId,
        fact,
        source: "senior",
        ...fields,
      }),
  );
}

/**
 * purpose: Read the voice agent's context for the family household.
 * @param w: (World) The world.
 * @return: The getContext result.
 */
async function agentContext(w: World) {
  return await w.t.query(api.agent.getContext, {
    agentKey: AGENT_KEY,
    householdId: w.householdId,
    now: NOW,
  });
}

/**
 * purpose: Rows of a table directly, for counting.
 * @param w: (World) The world.
 * @param table: (string) Table name.
 * @return: (Promise<number>) How many rows the family household has in it.
 */
async function countRows(
  w: World,
  table: "lifeProfileEntries" | "sensitiveTopics" | "agentMemory" | "familyMessages",
): Promise<number> {
  return await w.t.run(
    async (ctx) =>
      (
        await ctx.db
          .query(table)
          .withIndex("by_household", (q) => q.eq("householdId", w.householdId))
          .collect()
      ).length,
  );
}

describe("access", () => {
  test.each([
    ["listEntries", api.profile.listEntries],
    ["listMemory", api.profile.listMemory],
    ["listMessages", api.profile.listMessages],
  ] as const)("%s is readable by every role and the paired device", async (_name, fn) => {
    const w = await setup();
    for (const caller of [w.pat, w.max, w.val, w.phone]) {
      await expect(caller.query(fn, { householdId: w.householdId })).resolves.toEqual([]);
    }
  });

  test("listTopics is readable by every caregiver role but not the device", async () => {
    const w = await setup();
    for (const caller of [w.pat, w.max, w.val]) {
      await expect(
        caller.query(api.profile.listTopics, { householdId: w.householdId }),
      ).resolves.toEqual([]);
    }
    await expect(
      w.phone.query(api.profile.listTopics, { householdId: w.householdId }),
    ).rejects.toMatchObject({ data: { code: "forbidden" } });
  });

  test.each([
    ["listEntries", api.profile.listEntries],
    ["listTopics", api.profile.listTopics],
    ["listMemory", api.profile.listMemory],
    ["listMessages", api.profile.listMessages],
  ] as const)("%s refuses outsiders and signed-out callers", async (_name, fn) => {
    const w = await setup();
    await expect(w.outsider.query(fn, { householdId: w.householdId })).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    await expect(w.t.query(fn, { householdId: w.householdId })).rejects.toMatchObject({
      data: { code: "unauthenticated" },
    });
  });

  /**
   * purpose: Every write, as a function of the world (rows it needs are created by Pat first).
   * @return: Pairs of name and a function calling the write as the given caller.
   */
  const writes: Array<[string, (w: World, caller: Caller) => Promise<unknown>]> = [
    [
      "addEntry",
      (w, c) =>
        c.mutation(api.profile.addEntry, {
          householdId: w.householdId,
          category: "person",
          name: "Sarah",
        }),
    ],
    [
      "updateEntry",
      async (w, c) => {
        const { id } = await w.pat.mutation(api.profile.addEntry, {
          householdId: w.householdId,
          category: "place",
          name: "Library",
        });
        return c.mutation(api.profile.updateEntry, {
          householdId: w.householdId,
          entryId: id,
          name: "Town library",
        });
      },
    ],
    [
      "removeEntry",
      async (w, c) => {
        const { id } = await w.pat.mutation(api.profile.addEntry, {
          householdId: w.householdId,
          category: "place",
          name: "Park",
        });
        return c.mutation(api.profile.removeEntry, { householdId: w.householdId, entryId: id });
      },
    ],
    [
      "addTopic",
      (w, c) =>
        c.mutation(api.profile.addTopic, {
          householdId: w.householdId,
          topic: "money",
          guidance: "Say it is taken care of.",
        }),
    ],
    [
      "updateTopic",
      async (w, c) => {
        const { id } = await w.pat.mutation(api.profile.addTopic, {
          householdId: w.householdId,
          topic: "driving",
          guidance: "Say the car is at the shop.",
        });
        return c.mutation(api.profile.updateTopic, {
          householdId: w.householdId,
          topicId: id,
          guidance: "Say Sarah drives today.",
        });
      },
    ],
    [
      "removeTopic",
      async (w, c) => {
        const { id } = await w.pat.mutation(api.profile.addTopic, {
          householdId: w.householdId,
          topic: "moving",
          guidance: "Change the subject.",
        });
        return c.mutation(api.profile.removeTopic, { householdId: w.householdId, topicId: id });
      },
    ],
    [
      "addFact",
      (w, c) => c.mutation(api.profile.addFact, { householdId: w.householdId, fact: "Likes tea" }),
    ],
    [
      "verifyFact",
      async (w, c) =>
        c.mutation(api.profile.verifyFact, {
          householdId: w.householdId,
          factId: await insertFact(w, "Went to the market"),
        }),
    ],
    [
      "correctFact",
      async (w, c) =>
        c.mutation(api.profile.correctFact, {
          householdId: w.householdId,
          factId: await insertFact(w, "Went to the markt"),
          fact: "Went to the market",
        }),
    ],
    [
      "removeFact",
      async (w, c) =>
        c.mutation(api.profile.removeFact, {
          householdId: w.householdId,
          factId: await insertFact(w, "Likes rain"),
        }),
    ],
    [
      "sendMessage",
      (w, c) => c.mutation(api.profile.sendMessage, { householdId: w.householdId, body: "Hi Mom" }),
    ],
  ];

  test.each(writes)("%s works for the primary and a member", async (_name, write) => {
    const w = await setup();
    await expect(write(w, w.pat)).resolves.not.toThrow();
    const w2 = await setup();
    await expect(write(w2, w2.max)).resolves.not.toThrow();
  });

  test.each(writes)(
    "%s refuses the viewer, the device, an outsider and a signed-out caller",
    async (_name, write) => {
      const w = await setup();
      for (const caller of [w.val, w.phone, w.outsider]) {
        await expect(write(w, caller)).rejects.toMatchObject({ data: { code: "forbidden" } });
      }
      await expect(write(w, w.t as unknown as Caller)).rejects.toMatchObject({
        data: { code: "unauthenticated" },
      });
    },
  );
});

describe("household isolation", () => {
  test("a caregiver of another household cannot reach rows through their own household", async () => {
    const w = await setup();
    const { id: entryId } = await w.pat.mutation(api.profile.addEntry, {
      householdId: w.householdId,
      category: "person",
      name: "Sarah",
    });
    const { id: topicId } = await w.pat.mutation(api.profile.addTopic, {
      householdId: w.householdId,
      topic: "her husband",
      guidance: "Be gentle.",
    });
    const factId = await insertFact(w, "Has a cat");
    const other = w.otherHouseholdId;
    const attempts = [
      w.outsider.mutation(api.profile.updateEntry, { householdId: other, entryId, name: "X" }),
      w.outsider.mutation(api.profile.removeEntry, { householdId: other, entryId }),
      w.outsider.mutation(api.profile.updateTopic, { householdId: other, topicId, topic: "X" }),
      w.outsider.mutation(api.profile.removeTopic, { householdId: other, topicId }),
      w.outsider.mutation(api.profile.verifyFact, { householdId: other, factId }),
      w.outsider.mutation(api.profile.correctFact, { householdId: other, factId, fact: "X" }),
      w.outsider.mutation(api.profile.removeFact, { householdId: other, factId }),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({ data: { code: "not_found" } });
    }
    expect(await countRows(w, "lifeProfileEntries")).toBe(1);
    expect(await countRows(w, "sensitiveTopics")).toBe(1);
    expect(await countRows(w, "agentMemory")).toBe(1);
  });

  test("lists return only the caller's household", async () => {
    const w = await setup();
    await w.pat.mutation(api.profile.addEntry, {
      householdId: w.householdId,
      category: "person",
      name: "Sarah",
    });
    await w.pat.mutation(api.profile.sendMessage, { householdId: w.householdId, body: "Hi" });
    const other = { householdId: w.otherHouseholdId };
    expect(await w.outsider.query(api.profile.listEntries, other)).toEqual([]);
    expect(await w.outsider.query(api.profile.listMessages, other)).toEqual([]);
  });
});

describe("life profile entries", () => {
  test("add cleans the text, lists in the agent's order and audits", async () => {
    const w = await setup();
    const add = (category: Doc<"lifeProfileEntries">["category"], name: string, details?: string) =>
      w.pat.mutation(api.profile.addEntry, { householdId: w.householdId, category, name, details });
    await add("place", "Corner  bakery");
    const sarah = await add("person", "  Sarah ", "  Daughter,\nlives in Boston  ");
    await add("person", "Ben", "   ");
    expect(sarah.created).toBe(true);
    const list = await w.val.query(api.profile.listEntries, { householdId: w.householdId });
    expect(list).toEqual([
      { id: expect.any(String), category: "person", name: "Ben", details: null },
      { id: sarah.id, category: "person", name: "Sarah", details: "Daughter,\nlives in Boston" },
      { id: expect.any(String), category: "place", name: "Corner bakery", details: null },
    ]);
    const rows = await auditRows(w, "lifeProfileEntry");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      action: "insert",
      actorKind: "caregiver",
      actorUserId: "pat",
      entityId: sarah.id,
      detail: { category: "person", name: "Sarah" },
    });
    const context = await agentContext(w);
    expect(context.lifeProfile).toEqual(
      list.map(({ category, name, details }) => ({ category, name, details })),
    );
  });

  test("adding the same category and name again returns the existing entry", async () => {
    const w = await setup();
    const args = { householdId: w.householdId, category: "person" as const, name: "Sarah" };
    const first = await w.pat.mutation(api.profile.addEntry, args);
    const again = await w.max.mutation(api.profile.addEntry, {
      ...args,
      name: " sarah ",
      details: "Different details",
    });
    expect(again).toEqual({ id: first.id, created: false });
    const same = await w.pat.mutation(api.profile.addEntry, { ...args, category: "doctor" });
    expect(same.created).toBe(true);
    expect(await countRows(w, "lifeProfileEntries")).toBe(2);
    expect(await auditRows(w, "lifeProfileEntry")).toHaveLength(2);
  });

  test.each([
    ["a blank name", { name: "   " }, "invalid"],
    ["a name that is too long", { name: "n".repeat(MAX_NAME + 1) }, "invalid"],
    [
      "details that are too long",
      { name: "Sarah", details: "d".repeat(MAX_DETAILS + 1) },
      "invalid",
    ],
  ])("add rejects %s", async (_label, fields, code) => {
    const w = await setup();
    await expect(
      w.pat.mutation(api.profile.addEntry, {
        householdId: w.householdId,
        category: "person",
        ...fields,
      }),
    ).rejects.toMatchObject({ data: { code } });
  });

  test("add accepts text at the caps", async () => {
    const w = await setup();
    const result = await w.pat.mutation(api.profile.addEntry, {
      householdId: w.householdId,
      category: "other",
      name: "n".repeat(MAX_NAME),
      details: "d".repeat(MAX_DETAILS),
    });
    expect(result.created).toBe(true);
  });

  test("add refuses a new entry once the household has the most entries", async () => {
    const w = await setup();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < MAX_ENTRIES; i++) {
        await ctx.db.insert("lifeProfileEntries", {
          householdId: w.householdId,
          category: "other",
          name: `Entry ${i}`,
        });
      }
    });
    const add = (name: string) =>
      w.pat.mutation(api.profile.addEntry, { householdId: w.householdId, category: "other", name });
    await expect(add("One more")).rejects.toMatchObject({ data: { code: "limit" } });
    await expect(add("Entry 3")).resolves.toMatchObject({ created: false });
  });

  test("update changes, clears and audits; a no-op writes nothing", async () => {
    const w = await setup();
    const { id } = await w.pat.mutation(api.profile.addEntry, {
      householdId: w.householdId,
      category: "person",
      name: "Sarah",
      details: "Daughter",
    });
    const update = (fields: Record<string, unknown>) =>
      w.max.mutation(api.profile.updateEntry, {
        householdId: w.householdId,
        entryId: id,
        ...fields,
      });
    await update({ category: "doctor", name: "Dr  Sarah Lee" });
    let row = await w.t.run(async (ctx) => await ctx.db.get(id));
    expect(row).toMatchObject({ category: "doctor", name: "Dr Sarah Lee", details: "Daughter" });
    await update({ details: null });
    row = await w.t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.details).toBeUndefined();
    await update({ details: "  " });
    await update({ name: "Dr Sarah Lee" });
    const rows = await auditRows(w, "lifeProfileEntry");
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "update"]);
    expect(rows[1]).toMatchObject({ actorUserId: "max", detail: { name: "Dr Sarah Lee" } });
  });

  test("update refuses a name another entry of the category already has", async () => {
    const w = await setup();
    const add = (name: string) =>
      w.pat.mutation(api.profile.addEntry, {
        householdId: w.householdId,
        category: "person",
        name,
      });
    await add("Sarah");
    const { id } = await add("Ben");
    await expect(
      w.pat.mutation(api.profile.updateEntry, {
        householdId: w.householdId,
        entryId: id,
        name: "SARAH",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(
      w.pat.mutation(api.profile.updateEntry, {
        householdId: w.householdId,
        entryId: id,
        name: "  ",
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("remove deletes the entry and audits what it was", async () => {
    const w = await setup();
    const { id } = await w.pat.mutation(api.profile.addEntry, {
      householdId: w.householdId,
      category: "habit",
      name: "Morning walk",
    });
    await w.max.mutation(api.profile.removeEntry, { householdId: w.householdId, entryId: id });
    expect(await countRows(w, "lifeProfileEntries")).toBe(0);
    const rows = await auditRows(w, "lifeProfileEntry");
    expect(rows[1]).toMatchObject({
      action: "delete",
      entityId: id,
      detail: { category: "habit", name: "Morning walk" },
    });
    await expect(
      w.max.mutation(api.profile.removeEntry, { householdId: w.householdId, entryId: id }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });
});

describe("sensitive topics", () => {
  test("add keeps the guidance's line breaks, lists in creation order and reaches the agent", async () => {
    const w = await setup();
    const add = (topic: string, guidance: string) =>
      w.pat.mutation(api.profile.addTopic, { householdId: w.householdId, topic, guidance });
    await add(" her  husband Robert ", "  He died in 2019.\nSay he loved her very much.  ");
    await add("money", "Say the bills are paid.");
    const list = await w.val.query(api.profile.listTopics, { householdId: w.householdId });
    expect(list.map(({ topic, guidance }) => ({ topic, guidance }))).toEqual([
      { topic: "her husband Robert", guidance: "He died in 2019.\nSay he loved her very much." },
      { topic: "money", guidance: "Say the bills are paid." },
    ]);
    expect((await agentContext(w)).sensitiveTopics).toEqual(
      list.map(({ topic, guidance }) => ({ topic, guidance })),
    );
    expect(await auditRows(w, "sensitiveTopic")).toMatchObject([
      { action: "insert", detail: { topic: "her husband Robert" } },
      { action: "insert", detail: { topic: "money" } },
    ]);
  });

  test("adding the same topic again returns the existing one", async () => {
    const w = await setup();
    const first = await w.pat.mutation(api.profile.addTopic, {
      householdId: w.householdId,
      topic: "Money",
      guidance: "A",
    });
    const again = await w.pat.mutation(api.profile.addTopic, {
      householdId: w.householdId,
      topic: "money ",
      guidance: "B",
    });
    expect(again).toEqual({ id: first.id, created: false });
    expect(await countRows(w, "sensitiveTopics")).toBe(1);
  });

  test.each([
    ["a blank topic", { topic: " ", guidance: "G" }],
    ["blank guidance", { topic: "T", guidance: " \n " }],
    ["a topic that is too long", { topic: "t".repeat(MAX_TOPIC + 1), guidance: "G" }],
    ["guidance that is too long", { topic: "T", guidance: "g".repeat(MAX_GUIDANCE + 1) }],
  ])("add rejects %s", async (_label, fields) => {
    const w = await setup();
    await expect(
      w.pat.mutation(api.profile.addTopic, { householdId: w.householdId, ...fields }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("add refuses a new topic once the household has the most topics", async () => {
    const w = await setup();
    for (let i = 0; i < MAX_TOPICS; i++) {
      await w.pat.mutation(api.profile.addTopic, {
        householdId: w.householdId,
        topic: `Topic ${i}`,
        guidance: "G",
      });
    }
    await expect(
      w.pat.mutation(api.profile.addTopic, {
        householdId: w.householdId,
        topic: "One more",
        guidance: "G",
      }),
    ).rejects.toMatchObject({ data: { code: "limit" } });
  });

  test("update changes, audits, refuses a taken wording and skips a no-op", async () => {
    const w = await setup();
    const add = (topic: string) =>
      w.pat.mutation(api.profile.addTopic, { householdId: w.householdId, topic, guidance: "G" });
    await add("money");
    const { id } = await add("driving");
    const update = (fields: Record<string, unknown>) =>
      w.max.mutation(api.profile.updateTopic, {
        householdId: w.householdId,
        topicId: id,
        ...fields,
      });
    await update({ guidance: "Say the car is in the shop." });
    await update({ guidance: "Say the car is in the shop." });
    await expect(update({ topic: "Money" })).rejects.toMatchObject({ data: { code: "invalid" } });
    await expect(update({ guidance: "" })).rejects.toMatchObject({ data: { code: "invalid" } });
    const row = await w.t.run(async (ctx) => await ctx.db.get(id));
    expect(row).toMatchObject({ topic: "driving", guidance: "Say the car is in the shop." });
    expect((await auditRows(w, "sensitiveTopic")).map((r) => r.action)).toEqual([
      "insert",
      "insert",
      "update",
    ]);
  });

  test("remove deletes the topic and audits it", async () => {
    const w = await setup();
    const { id } = await w.pat.mutation(api.profile.addTopic, {
      householdId: w.householdId,
      topic: "money",
      guidance: "G",
    });
    await w.pat.mutation(api.profile.removeTopic, { householdId: w.householdId, topicId: id });
    expect(await countRows(w, "sensitiveTopics")).toBe(0);
    expect((await auditRows(w, "sensitiveTopic"))[1]).toMatchObject({
      action: "delete",
      detail: { topic: "money" },
    });
  });
});

describe("agent memory", () => {
  test("a caregiver fact is verified at once and listed with names and local dates", async () => {
    const w = await setup();
    const { id, created } = await w.max.mutation(api.profile.addFact, {
      householdId: w.householdId,
      fact: "  Her cat is  called Biscuit ",
    });
    expect(created).toBe(true);
    expect(await w.phone.query(api.profile.listMemory, { householdId: w.householdId })).toEqual([
      {
        id,
        fact: "Her cat is called Biscuit",
        source: "caregiver",
        verified: true,
        verifiedByName: "Max",
        notedOn: "2027-03-10",
        verifiedOn: "2027-03-10",
      },
    ]);
    expect(await auditRows(w, "agentMemory")).toMatchObject([
      { action: "insert", actorUserId: "max", detail: { fact: "Her cat is called Biscuit" } },
    ]);
  });

  test("list puts verified facts first, then newest, as the agent reads them", async () => {
    const w = await setup();
    await insertFact(w, "Old senior fact");
    vi.setSystemTime(NOW + 1000);
    await w.pat.mutation(api.profile.addFact, { householdId: w.householdId, fact: "Verified" });
    vi.setSystemTime(NOW + 2000);
    await insertFact(w, "New senior fact");
    const list = await w.pat.query(api.profile.listMemory, { householdId: w.householdId });
    expect(list.map((f) => [f.fact, f.verified, f.source])).toEqual([
      ["Verified", true, "caregiver"],
      ["New senior fact", false, "senior"],
      ["Old senior fact", false, "senior"],
    ]);
    expect((await agentContext(w)).memory.map((m) => [m.fact, m.verified])).toEqual(
      list.map((f) => [f.fact, f.verified]),
    );
  });

  test("verifying a senior-stated fact records the caregiver and keeps the source", async () => {
    const w = await setup();
    const factId = await insertFact(w, "Sarah visited on Sunday");
    await w.max.mutation(api.profile.verifyFact, { householdId: w.householdId, factId });
    vi.setSystemTime(NOW + 60_000);
    await w.pat.mutation(api.profile.verifyFact, { householdId: w.householdId, factId });
    const row = await w.t.run(async (ctx) => await ctx.db.get(factId));
    expect(row).toMatchObject({ source: "senior", verifiedBy: "max" });
    expect(row!.verifiedAt).toBeLessThan(NOW + 60_000);
    expect((await auditRows(w, "agentMemory")).map((r) => [r.action, r.actorUserId])).toEqual([
      ["verify", "max"],
    ]);
  });

  test("a correction replaces the text, verifies the fact and keeps its source", async () => {
    const w = await setup();
    const factId = await insertFact(w, "Sarah lives in Bostn");
    await w.pat.mutation(api.profile.correctFact, {
      householdId: w.householdId,
      factId,
      fact: "Sarah lives in Boston",
    });
    const row = await w.t.run(async (ctx) => await ctx.db.get(factId));
    expect(row).toMatchObject({
      fact: "Sarah lives in Boston",
      source: "senior",
      verifiedBy: "pat",
      verifiedAt: expect.any(Number),
    });
    expect((await auditRows(w, "agentMemory"))[0]).toMatchObject({
      action: "correct",
      detail: { fact: "Sarah lives in Boston", previous: "Sarah lives in Bostn", source: "senior" },
    });
  });

  test("correcting with the same text verifies an unverified fact and skips a verified one", async () => {
    const w = await setup();
    const factId = await insertFact(w, "Likes jazz");
    const correct = () =>
      w.pat.mutation(api.profile.correctFact, {
        householdId: w.householdId,
        factId,
        fact: "Likes jazz",
      });
    await correct();
    await correct();
    const row = await w.t.run(async (ctx) => await ctx.db.get(factId));
    expect(row?.verifiedBy).toBe("pat");
    expect(await auditRows(w, "agentMemory")).toHaveLength(1);
  });

  test("a correction may not repeat another fact, nor be blank or too long", async () => {
    const w = await setup();
    await insertFact(w, "Likes jazz");
    const factId = await insertFact(w, "Likes blues");
    for (const fact of ["likes  JAZZ", " ", "f".repeat(MAX_FACT + 1)]) {
      await expect(
        w.pat.mutation(api.profile.correctFact, { householdId: w.householdId, factId, fact }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
  });

  test("adding a fact the senior already stated verifies it instead of duplicating it", async () => {
    const w = await setup();
    const factId = await insertFact(w, "Sarah has two children");
    const result = await w.pat.mutation(api.profile.addFact, {
      householdId: w.householdId,
      fact: "sarah has two children",
    });
    expect(result).toEqual({ id: factId, created: false });
    const row = await w.t.run(async (ctx) => await ctx.db.get(factId));
    expect(row).toMatchObject({ fact: "Sarah has two children", verifiedBy: "pat" });
    expect(await countRows(w, "agentMemory")).toBe(1);
  });

  test("adding a verified fact again changes nothing", async () => {
    const w = await setup();
    const first = await w.pat.mutation(api.profile.addFact, {
      householdId: w.householdId,
      fact: "Likes tea",
    });
    const again = await w.max.mutation(api.profile.addFact, {
      householdId: w.householdId,
      fact: "Likes tea",
    });
    expect(again).toEqual({ id: first.id, created: false });
    const row = await w.t.run(async (ctx) => await ctx.db.get(first.id));
    expect(row?.verifiedBy).toBe("pat");
    expect(await auditRows(w, "agentMemory")).toHaveLength(1);
  });

  test.each([
    ["blank", "  "],
    ["too long", "f".repeat(MAX_FACT + 1)],
  ])("add rejects a %s fact", async (_label, fact) => {
    const w = await setup();
    await expect(
      w.pat.mutation(api.profile.addFact, { householdId: w.householdId, fact }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("verified facts are capped at the agent's window, and all of them reach the agent", async () => {
    const w = await setup();
    for (let i = 0; i < MAX_VERIFIED_FACTS; i++) {
      vi.setSystemTime(NOW + i);
      await w.pat.mutation(api.profile.addFact, { householdId: w.householdId, fact: `Fact ${i}` });
    }
    vi.setSystemTime(NOW + MAX_VERIFIED_FACTS);
    const seniorFact = await insertFact(w, "Senior fact");
    await expect(
      w.pat.mutation(api.profile.addFact, { householdId: w.householdId, fact: "One more" }),
    ).rejects.toMatchObject({ data: { code: "limit" } });
    await expect(
      w.pat.mutation(api.profile.verifyFact, { householdId: w.householdId, factId: seniorFact }),
    ).rejects.toMatchObject({ data: { code: "limit" } });
    await expect(
      w.pat.mutation(api.profile.correctFact, {
        householdId: w.householdId,
        factId: seniorFact,
        fact: "Corrected",
      }),
    ).rejects.toMatchObject({ data: { code: "limit" } });
    const memory = (await agentContext(w)).memory;
    expect(memory.filter((m) => m.verified)).toHaveLength(MAX_VERIFIED_FACTS);

    const list = await w.pat.query(api.profile.listMemory, { householdId: w.householdId });
    await w.pat.mutation(api.profile.correctFact, {
      householdId: w.householdId,
      factId: list[0]!.id,
      fact: "A verified fact can still be corrected at the cap",
    });
  });

  test("remove deletes any fact and audits it", async () => {
    const w = await setup();
    const factId = await insertFact(w, "Likes rain");
    await w.max.mutation(api.profile.removeFact, { householdId: w.householdId, factId });
    expect(await countRows(w, "agentMemory")).toBe(0);
    expect(await auditRows(w, "agentMemory")).toMatchObject([
      { action: "delete", detail: { fact: "Likes rain", source: "senior" } },
    ]);
  });
});

describe("family messages", () => {
  test("send stores a trimmed caregiver message that the agent reads as the latest", async () => {
    const w = await setup();
    const id = await w.max.mutation(api.profile.sendMessage, {
      householdId: w.householdId,
      body: "  Coming by at noon.\nLove, Max  ",
    });
    const row = await w.t.run(async (ctx) => await ctx.db.get(id));
    expect(row).toMatchObject({
      senderKind: "caregiver",
      senderUserId: "max",
      body: "Coming by at noon.\nLove, Max",
    });
    expect((await agentContext(w)).latestMessage).toEqual({
      from: "Max",
      body: "Coming by at noon.\nLove, Max",
      hasPhoto: false,
      sentAt: expect.any(Number),
      seen: false,
    });
    expect(await auditRows(w, "familyMessage")).toMatchObject([
      { action: "insert", actorUserId: "max", entityId: id, detail: { length: 28 } },
    ]);
  });

  test.each([
    ["blank", " \n "],
    ["too long", "m".repeat(MAX_MESSAGE + 1)],
  ])("send rejects a %s message", async (_label, body) => {
    const w = await setup();
    await expect(
      w.pat.mutation(api.profile.sendMessage, { householdId: w.householdId, body }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });

  test("list shows both directions newest first, with names, seen state and local time", async () => {
    const w = await setup();
    await w.pat.mutation(api.profile.sendMessage, { householdId: w.householdId, body: "Hello" });
    vi.setSystemTime(NOW + 60_000);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("familyMessages", {
        householdId: w.householdId,
        senderKind: "senior",
        body: "I am home",
      });
      await ctx.db.insert("familyMessages", {
        householdId: w.householdId,
        senderKind: "caregiver",
        senderUserId: "former_member",
        body: "Old note",
        seenAt: NOW + 30_000,
      });
    });
    const list = await w.val.query(api.profile.listMessages, { householdId: w.householdId });
    expect(list.map((m) => [m.senderName, m.senderKind, m.body, m.seenAt])).toEqual([
      ["Family", "caregiver", "Old note", NOW + 30_000],
      ["Mom", "senior", "I am home", null],
      ["Pat", "caregiver", "Hello", null],
    ]);
    expect(list[2]).toMatchObject({
      senderUserId: "pat",
      hasPhoto: false,
      hasAudio: false,
      sentAt: expect.any(Number),
      sentDate: "2027-03-10",
      sentTime: "10:00",
    });
    expect(list[1]!.senderUserId).toBeNull();
  });

  test("list honors the limit and rejects one out of range", async () => {
    const w = await setup();
    for (const body of ["one", "two", "three"]) {
      await w.pat.mutation(api.profile.sendMessage, { householdId: w.householdId, body });
    }
    const two = await w.pat.query(api.profile.listMessages, {
      householdId: w.householdId,
      limit: 2,
    });
    expect(two.map((m) => m.body)).toEqual(["three", "two"]);
    for (const limit of [0, 101, 1.5]) {
      await expect(
        w.pat.query(api.profile.listMessages, { householdId: w.householdId, limit }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    }
  });
});
