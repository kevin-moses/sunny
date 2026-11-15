// agentSetupTools.test.ts
// Purpose: Tests for the household agent's setup tools (lib/agentSetupTools.ts) and the chat's
// wording cards (agentRequests.transcript), with convex-test and frozen clocks. Knowledge:
// add_knowledge for each kind stores through the About tab's cores (same rows, same cleaning,
// same error text, same limits, audit rows under the requesting caregiver with the request id),
// reports added, already_stored, already_stored_differently and confirmed, and returns the item
// as stored; update_knowledge corrects, clears, confirms and refuses bad changes;
// remove_knowledge names what it removed; get_knowledge lists all three kinds or one. The
// memory rule: a fact the senior said never overwrites one a caregiver stored by chat, and a
// correction by chat keeps the senior source while verifying it. Settings: get_settings shape;
// update_settings for the digest time (a bad time is refused with households.update's error),
// on-call by name (whole name, first name, case; unknown and ambiguous names refused listing the
// choices, nothing changed), sharing, the weather place (set and cleared) and its audit row;
// set_digest_delivery names the caregiver and the new setting. Scoping: every tool acts on the
// request's household only (another household's knowledge_id is not found, another
// household's caregiver name is unknown, a model-supplied household id is an unknown field), and
// through the runtime a viewer's request runs no tool. Wording cards: a request's add_task and
// update_task calls give one card per task with the live label, the display's time and the
// sentence the display speaks; a written prompt is used as is; an anytime task has no sentence;
// a stopped task and a failed call have no card; viewers get no requests and so no cards.
//
// Last modified: 2026-11-14

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { AGENT_TOOLS, executeAgentTool } from "./lib/agentTools";
import { resolveCaregiver } from "./lib/agentSetupTools";
import { rememberFactCore } from "./lib/seniorMemory";
import {
  addMember,
  createHousehold,
  insertRequest,
  makeBackend,
  type TestConvex,
} from "./testing.helpers";

/** Monday 2027-03-01, 07:00 in New York (EST). */
const NOW = Date.parse("2027-03-01T12:00:00Z");

/** A household (Pat primary, Max member, Val viewer) and another one (Ben). */
interface World {
  t: TestConvex;
  home: Id<"households">;
  other: Id<"households">;
}

/** Result of a tool call. */
interface ToolResult {
  text: string;
  isError: boolean;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * purpose: Create the two households through the real mutations.
 * @return: (Promise<World>) Harness and household ids.
 */
async function makeWorld(): Promise<World> {
  const t = makeBackend();
  const home = await createHousehold(t, {
    subject: "pat",
    seniorName: "Mom",
    caregiverName: "Pat",
  });
  await addMember(t, home, "max", "member", "Max");
  await addMember(t, home, "val", "viewer", "Val");
  const other = await createHousehold(t, { subject: "ben", caregiverName: "Ben" });
  return { t, home, other };
}

/**
 * purpose: Run a tool as the runtime does: the household agent acting for a caregiver.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) The request's household.
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input.
 * @param requestedBy: (string) The requesting caregiver (default pat).
 * @param requestId: (Id<"agentRequests">, optional) The request, recorded on audit rows.
 * @return: (Promise<ToolResult>) The result.
 */
async function tool(
  t: TestConvex,
  householdId: Id<"households">,
  name: string,
  input: Record<string, unknown>,
  requestedBy = "pat",
  requestId?: Id<"agentRequests">,
): Promise<ToolResult> {
  const actor = { kind: "agent", onBehalfOf: requestedBy, requestId } as const;
  return await t.run(
    async (ctx) => await executeAgentTool(ctx, { householdId, actor, now: NOW }, { name, input }),
  );
}

/**
 * purpose: Run a tool and parse its successful result.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @param name: (string) Tool name.
 * @param input: (Record<string, unknown>) Tool input.
 * @return: (Promise<any>) The parsed result.
 * @raises when the tool returned an error.
 */
async function ok(
  t: TestConvex,
  householdId: Id<"households">,
  name: string,
  input: object,
): Promise<any> {
  const result = await tool(t, householdId, name, input as Record<string, unknown>);
  if (result.isError) throw new Error(result.text);
  return JSON.parse(result.text);
}

/**
 * purpose: Read every row of a table.
 * @param t: (TestConvex) Harness.
 * @param table: (T) The table.
 * @return: (Promise<Doc<T>[]>) The rows.
 */
async function rows<
  T extends
    | "lifeProfileEntries"
    | "sensitiveTopics"
    | "agentMemory"
    | "auditLog"
    | "householdMembers"
    | "tasks",
>(t: TestConvex, table: T): Promise<Doc<T>[]> {
  return (await t.run(async (ctx) => await ctx.db.query(table).collect())) as Doc<T>[];
}

/**
 * purpose: The household row.
 * @param t: (TestConvex) Harness.
 * @param householdId: (Id<"households">) Household.
 * @return: (Promise<Doc<"households">>) The row.
 */
async function household(t: TestConvex, householdId: Id<"households">): Promise<Doc<"households">> {
  return (await t.run(async (ctx) => await ctx.db.get(householdId)))!;
}

describe("tool list", () => {
  test("the setup tools are offered with the schedule tools", () => {
    const names = AGENT_TOOLS.map((tool) => ("name" in tool ? tool.name : ""));
    for (const name of [
      "get_knowledge",
      "add_knowledge",
      "update_knowledge",
      "remove_knowledge",
      "get_settings",
      "update_settings",
      "set_digest_delivery",
      "add_task",
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe("add_knowledge", () => {
  test("a profile entry is stored through the About tab's core and shown as stored", async () => {
    const { t, home } = await makeWorld();
    const requestId = await insertRequest(t, home, { requestedBy: "pat", status: "running" });
    const result = await tool(
      t,
      home,
      "add_knowledge",
      {
        kind: "profile",
        category: "doctor",
        name: "  Dr.   Patel ",
        details: "Her GP\non Main St",
      },
      "pat",
      requestId,
    );
    const parsed = JSON.parse(result.text);
    const [entry] = await rows(t, "lifeProfileEntries");
    expect(parsed).toEqual({
      status: "added",
      stored: {
        kind: "profile",
        knowledge_id: entry!._id,
        category: "doctor",
        name: "Dr. Patel",
        details: "Her GP on Main St",
      },
    });
    expect(entry).toMatchObject({ householdId: home, createdBy: "pat" });
    const listed = await t
      .withIdentity({ subject: "max" })
      .query(api.profile.listEntries, { householdId: home });
    expect(listed.map((e) => e.name)).toEqual(["Dr. Patel"]);
    const audit = (await rows(t, "auditLog")).find((r) => r.entity === "lifeProfileEntry")!;
    expect(audit).toMatchObject({
      action: "insert",
      actorKind: "agent",
      actorUserId: "pat",
      detail: { requestId, name: "Dr. Patel" },
    });
  });

  test("an existing entry is reported, unchanged, as already stored the same or differently", async () => {
    const { t, home } = await makeWorld();
    await ok(t, home, "add_knowledge", {
      kind: "profile",
      category: "person",
      name: "Sarah",
      details: "Daughter",
    });
    const same = await ok(t, home, "add_knowledge", {
      kind: "profile",
      category: "person",
      name: "Sarah",
      details: "Daughter",
    });
    expect(same.status).toBe("already_stored");
    const differs = await ok(t, home, "add_knowledge", {
      kind: "profile",
      category: "person",
      name: "sarah",
      details: "Lives in Boston",
    });
    expect(differs).toMatchObject({
      status: "already_stored_differently",
      stored: { name: "Sarah", details: "Daughter" },
    });
    expect(await rows(t, "lifeProfileEntries")).toHaveLength(1);
  });

  test("a topic and a fact are stored; a caregiver fact is verified under the requester", async () => {
    const { t, home } = await makeWorld();
    const topic = await ok(t, home, "add_knowledge", {
      kind: "topic",
      topic: "her husband Robert",
      guidance: "Say he loved her and change the subject gently.",
    });
    expect(topic).toMatchObject({
      status: "added",
      stored: { kind: "topic", topic: "her husband Robert" },
    });
    const fact = await ok(t, home, "add_knowledge", {
      kind: "fact",
      fact: "Her cat is called Biscuit",
    });
    expect(fact.stored).toMatchObject({
      kind: "fact",
      fact: "Her cat is called Biscuit",
      source: "caregiver",
      verified: true,
    });
    expect((await rows(t, "agentMemory"))[0]).toMatchObject({ verifiedBy: "pat" });
  });

  test("adding a fact the senior said confirms it", async () => {
    const { t, home } = await makeWorld();
    await t.run(
      async (ctx) => await rememberFactCore(ctx, { householdId: home, fact: "She likes tulips" }),
    );
    const result = await ok(t, home, "add_knowledge", { kind: "fact", fact: "she likes  TULIPS" });
    expect(result).toMatchObject({
      status: "confirmed",
      stored: { fact: "She likes tulips", source: "senior", verified: true },
    });
  });

  test("bad input is a tool error in the About tab's words", async () => {
    const { t, home } = await makeWorld();
    const long = "x".repeat(121);
    const viaApp = await t
      .withIdentity({ subject: "pat" })
      .mutation(api.profile.addEntry, { householdId: home, category: "person", name: long })
      .catch((e: { data: { message: string } }) => e.data.message);
    const viaChat = await tool(t, home, "add_knowledge", {
      kind: "profile",
      category: "person",
      name: long,
    });
    expect(viaChat).toEqual({ text: `Error: ${viaApp}`, isError: true });
    expect(
      (
        await tool(t, home, "add_knowledge", {
          kind: "topic",
          topic: "x",
          guidance: "y",
          name: "z",
        })
      ).text,
    ).toBe("Error: Unknown field name");
    expect(
      (await tool(t, home, "add_knowledge", { kind: "profile", category: "pet", name: "Biscuit" }))
        .text,
    ).toMatch(/^Error: category must be one of person, place/);
    expect((await tool(t, home, "add_knowledge", { kind: "memory", fact: "x" })).text).toBe(
      "Error: kind must be one of profile, topic, fact",
    );
    expect((await tool(t, home, "add_knowledge", { kind: "fact" })).text).toBe(
      "Error: fact is missing or malformed",
    );
    expect(await rows(t, "lifeProfileEntries")).toHaveLength(0);
  });

  test("the About tab's limits hold in the chat", async () => {
    const { t, home } = await makeWorld();
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("sensitiveTopics", {
          householdId: home,
          topic: `t${i}`,
          guidance: "g",
        });
      }
    });
    expect(
      (await tool(t, home, "add_knowledge", { kind: "topic", topic: "one more", guidance: "g" }))
        .text,
    ).toBe("Error: The playbook holds at most 30 topics");
  });
});

describe("update_knowledge and remove_knowledge", () => {
  test("an entry is corrected, its details cleared, and the change audited with the previous text", async () => {
    const { t, home } = await makeWorld();
    const { stored } = await ok(t, home, "add_knowledge", {
      kind: "profile",
      category: "doctor",
      name: "Dr. Patel",
      details: "GP",
    });
    const renamed = await ok(t, home, "update_knowledge", {
      kind: "profile",
      knowledge_id: stored.knowledge_id,
      changes: { name: "Dr. Shah", details: null },
    });
    expect(renamed.stored).toEqual({ ...stored, name: "Dr. Shah", details: null });
    const audit = (await rows(t, "auditLog")).filter((r) => r.action === "update");
    expect(audit[0]?.detail).toMatchObject({ name: "Dr. Shah", previous: { name: "Dr. Patel" } });
  });

  test("a fact the senior said is corrected or confirmed, keeping its source", async () => {
    const { t, home } = await makeWorld();
    await t.run(async (ctx) => {
      await rememberFactCore(ctx, { householdId: home, fact: "My son visits on Sundays" });
      await rememberFactCore(ctx, { householdId: home, fact: "I walk at noon" });
    });
    const [sons, walk] = (await rows(t, "agentMemory")).map((r) => r._id);
    const corrected = await ok(t, home, "update_knowledge", {
      kind: "fact",
      knowledge_id: sons,
      changes: { fact: "Her son visits on Saturdays" },
    });
    expect(corrected.stored).toMatchObject({
      fact: "Her son visits on Saturdays",
      source: "senior",
      verified: true,
    });
    const confirmed = await ok(t, home, "update_knowledge", {
      kind: "fact",
      knowledge_id: walk,
      changes: { verified: true },
    });
    expect(confirmed.stored).toMatchObject({ fact: "I walk at noon", verified: true });
    expect(
      (
        await tool(t, home, "update_knowledge", {
          kind: "fact",
          knowledge_id: walk,
          changes: { verified: false },
        })
      ).text,
    ).toBe("Error: verified can only be true; use remove_knowledge for a wrong fact");
    expect(
      (await tool(t, home, "update_knowledge", { kind: "fact", knowledge_id: walk, changes: {} }))
        .text,
    ).toBe("Error: changes is empty");
  });

  test("remove_knowledge deletes the item and names what it removed", async () => {
    const { t, home } = await makeWorld();
    const { stored } = await ok(t, home, "add_knowledge", {
      kind: "topic",
      topic: "money",
      guidance: "Say Pat handles it.",
    });
    const result = await ok(t, home, "remove_knowledge", {
      kind: "topic",
      knowledge_id: stored.knowledge_id,
    });
    expect(result).toEqual({ removed: stored });
    expect(await rows(t, "sensitiveTopics")).toHaveLength(0);
    expect(
      (await rows(t, "auditLog")).some((r) => r.action === "delete" && r.actorUserId === "pat"),
    ).toBe(true);
  });

  test("an id of the wrong kind is refused", async () => {
    const { t, home } = await makeWorld();
    const { stored } = await ok(t, home, "add_knowledge", { kind: "fact", fact: "Likes jazz" });
    expect(
      (
        await tool(t, home, "remove_knowledge", {
          kind: "profile",
          knowledge_id: stored.knowledge_id,
        })
      ).text,
    ).toMatch(/^Error: knowledge_id is not a valid knowledge id/);
  });
});

describe("get_knowledge", () => {
  test("lists all three kinds, or one", async () => {
    const { t, home } = await makeWorld();
    await ok(t, home, "add_knowledge", {
      kind: "profile",
      category: "place",
      name: "Riverside Park",
    });
    await ok(t, home, "add_knowledge", { kind: "fact", fact: "Likes jazz" });
    const all = await ok(t, home, "get_knowledge", {});
    expect(all.profile.map((e: { name: string }) => e.name)).toEqual(["Riverside Park"]);
    expect(all.topics).toEqual([]);
    expect(all.facts.map((f: { fact: string }) => f.fact)).toEqual(["Likes jazz"]);
    expect(all.older_unverified_facts).toBe(0);
    expect(Object.keys(await ok(t, home, "get_knowledge", { kind: "topic" }))).toEqual(["topics"]);
  });
});

describe("memory rule", () => {
  test("what the senior says never overwrites a fact a caregiver stored by chat", async () => {
    const { t, home } = await makeWorld();
    const { stored } = await ok(t, home, "add_knowledge", {
      kind: "fact",
      fact: "Her cat is called Biscuit",
    });
    const again = await t.run(
      async (ctx) =>
        await rememberFactCore(ctx, { householdId: home, fact: "her cat is called biscuit" }),
    );
    expect(again).toEqual({ status: "already_known" });
    await t.run(
      async (ctx) =>
        await rememberFactCore(ctx, { householdId: home, fact: "My cat is called Max" }),
    );
    const facts = await rows(t, "agentMemory");
    expect(facts.find((f) => f._id === stored.knowledge_id)).toMatchObject({
      fact: "Her cat is called Biscuit",
      source: "caregiver",
      verifiedBy: "pat",
    });
    const senior = facts.find((f) => f.fact === "My cat is called Max");
    expect(senior?.source).toBe("senior");
    expect(senior?.verifiedAt).toBeUndefined();
  });
});

describe("settings", () => {
  test("get_settings returns every setting and the caregivers", async () => {
    const { t, home } = await makeWorld();
    await t.run(
      async (ctx) => await ctx.db.insert("pushTokens", { userId: "max", token: "max-1" }),
    );
    expect(await ok(t, home, "get_settings", {})).toEqual({
      digest_time: "19:00",
      on_call: "Pat",
      share_transcripts: false,
      weather_location: null,
      caregivers: [
        { name: "Max", role: "member", on_call: false, receives_digest: true, reachable: true },
        { name: "Pat", role: "primary", on_call: true, receives_digest: true, reachable: false },
        { name: "Val", role: "viewer", on_call: false, receives_digest: true, reachable: false },
      ],
    });
  });

  test("update_settings stores the digest time, sharing and place, audited under the requester", async () => {
    const { t, home } = await makeWorld();
    const result = await ok(t, home, "update_settings", {
      digest_time: "20:30",
      share_transcripts: true,
      weather_location: " Brooklyn, NY ",
    });
    expect(result).toMatchObject({
      digest_time: "20:30",
      share_transcripts: true,
      weather_location: "Brooklyn, NY",
    });
    expect(await household(t, home)).toMatchObject({
      digestTime: "20:30",
      shareTranscripts: true,
      weatherLocation: "Brooklyn, NY",
    });
    const audit = (await rows(t, "auditLog")).find((r) => r.action === "update_settings")!;
    expect(audit).toMatchObject({
      actorKind: "agent",
      actorUserId: "pat",
      detail: { digestTime: "20:30", shareTranscripts: true, weatherLocation: "Brooklyn, NY" },
    });
    for (const clear of [null, ""]) {
      await ok(t, home, "update_settings", { weather_location: "Queens" });
      expect(
        (await ok(t, home, "update_settings", { weather_location: clear })).weather_location,
      ).toBeNull();
      expect((await household(t, home)).weatherLocation).toBeUndefined();
    }
  });

  test("a bad time is refused with households.update's error and changes nothing", async () => {
    const { t, home } = await makeWorld();
    const viaApp = await t
      .withIdentity({ subject: "pat" })
      .mutation(api.households.update, { householdId: home, digestTime: "7pm" })
      .catch((e: { data: { message: string } }) => e.data.message);
    expect(viaApp).toBe("Digest time must be HH:MM");
    for (const time of ["7pm", "25:00", "7:00"]) {
      expect(await tool(t, home, "update_settings", { digest_time: time })).toEqual({
        text: `Error: ${viaApp}`,
        isError: true,
      });
    }
    expect((await household(t, home)).digestTime).toBe("19:00");
  });

  test("on call resolves a caregiver by whole or first name, ignoring case", async () => {
    const { t, home } = await makeWorld();
    await addMember(t, home, "sam", "member", "Sam Rivera");
    expect((await ok(t, home, "update_settings", { on_call: "MAX" })).on_call).toBe("Max");
    expect((await household(t, home)).onCallUserId).toBe("max");
    expect((await ok(t, home, "update_settings", { on_call: "sam" })).on_call).toBe("Sam Rivera");
    expect((await ok(t, home, "update_settings", { on_call: "sam  rivera" })).on_call).toBe(
      "Sam Rivera",
    );
  });

  test("an unknown or ambiguous name is refused with the choices and changes nothing", async () => {
    const { t, home } = await makeWorld();
    await addMember(t, home, "sam1", "member", "Sam Rivera");
    await addMember(t, home, "sam2", "member", "Sam Okafor");
    expect((await tool(t, home, "update_settings", { on_call: "Sarah" })).text).toBe(
      'Error: No caregiver of this household is called "Sarah". The caregivers are: Max, Pat, Sam Rivera, Sam Okafor, Val. Ask which one they mean.',
    );
    expect((await tool(t, home, "update_settings", { on_call: "Sam" })).text).toBe(
      'Error: More than one caregiver could be "Sam": Sam Rivera, Sam Okafor. Ask which one they mean.',
    );
    expect(
      (await tool(t, home, "set_digest_delivery", { caregiver: "Sam", receives: false })).isError,
    ).toBe(true);
    expect((await household(t, home)).onCallUserId).toBe("pat");
    expect((await rows(t, "householdMembers")).every((m) => m.digestOptOut === undefined)).toBe(
      true,
    );
  });

  test("update_settings refuses unknown fields, wrong types and an empty change", async () => {
    const { t, home } = await makeWorld();
    expect((await tool(t, home, "update_settings", { timezone: "UTC" })).text).toBe(
      "Error: Unknown field timezone",
    );
    expect((await tool(t, home, "update_settings", { share_transcripts: "yes" })).text).toBe(
      "Error: share_transcripts must be true or false",
    );
    expect((await tool(t, home, "update_settings", {})).text).toBe("Error: Nothing to change");
  });

  test("set_digest_delivery turns the digest off and on for a named caregiver", async () => {
    const { t, home } = await makeWorld();
    expect(await ok(t, home, "set_digest_delivery", { caregiver: "Val", receives: false })).toEqual(
      {
        name: "Val",
        role: "viewer",
        on_call: false,
        receives_digest: false,
        reachable: false,
      },
    );
    const val = (await rows(t, "householdMembers")).find((m) => m.userId === "val")!;
    expect(val.digestOptOut).toBe(true);
    const audit = (await rows(t, "auditLog")).find((r) => r.action === "digest_delivery")!;
    expect(audit).toMatchObject({ actorUserId: "pat", detail: { userId: "val", receives: false } });
    expect(
      (await ok(t, home, "set_digest_delivery", { caregiver: "val", receives: true }))
        .receives_digest,
    ).toBe(true);
    expect(
      (await rows(t, "householdMembers")).find((m) => m.userId === "val")!.digestOptOut,
    ).toBeUndefined();
  });

  test("resolveCaregiver prefers the whole name over a first-name match", () => {
    /**
     * purpose: A member row with only the fields the resolver reads.
     * @param userId: (string) User id.
     * @param displayName: (string) Display name.
     * @return: (Doc<"householdMembers">) The row.
     */
    const member = (userId: string, displayName: string): Doc<"householdMembers"> =>
      ({ userId, displayName }) as Doc<"householdMembers">;
    const members = [member("a", "Sam"), member("b", "Sam Rivera")];
    expect(resolveCaregiver(members, "sam").userId).toBe("a");
  });
});

describe("household scoping", () => {
  test("a knowledge_id of another household is not found and nothing changes", async () => {
    const { t, home, other } = await makeWorld();
    const { stored } = await ok(t, other, "add_knowledge", {
      kind: "fact",
      fact: "Walter likes chess",
    });
    for (const [name, input] of [
      [
        "update_knowledge",
        { kind: "fact", knowledge_id: stored.knowledge_id, changes: { fact: "x" } },
      ],
      ["remove_knowledge", { kind: "fact", knowledge_id: stored.knowledge_id }],
    ] as const) {
      expect(await tool(t, home, name, input)).toEqual({
        text: "Error: Fact not found",
        isError: true,
      });
    }
    expect((await rows(t, "agentMemory"))[0]).toMatchObject({
      fact: "Walter likes chess",
      householdId: other,
    });
    expect((await ok(t, home, "get_knowledge", {})).facts).toEqual([]);
  });

  test("another household's caregiver cannot be named, and no tool takes a household id", async () => {
    const { t, home } = await makeWorld();
    expect((await tool(t, home, "update_settings", { on_call: "Ben" })).text).toMatch(
      /^Error: No caregiver of this household is called "Ben"/,
    );
    expect((await tool(t, home, "get_settings", { household_id: "x" })).text).toBe(
      "Error: Unknown field household_id",
    );
    expect((await tool(t, home, "get_knowledge", { household_id: "x" })).text).toBe(
      "Error: Unknown field household_id",
    );
  });

  test("a viewer's request runs no tool through the runtime; an editor's does", async () => {
    const { t, home } = await makeWorld();
    const call = (id: string) => ({
      toolUseId: id,
      name: "add_knowledge",
      input: JSON.stringify({ kind: "fact", fact: "Likes jazz" }),
    });
    const byViewer = await insertRequest(t, home, { requestedBy: "val", status: "running" });
    expect(
      await t.mutation(internal.agentRuntime.executeToolCalls, {
        requestId: byViewer,
        calls: [call("v1")],
      }),
    ).toMatchObject({ kind: "failed" });
    expect(await rows(t, "agentMemory")).toHaveLength(0);
    const byEditor = await insertRequest(t, home, { requestedBy: "max", status: "running" });
    await t.mutation(internal.agentRuntime.executeToolCalls, {
      requestId: byEditor,
      calls: [call("m1")],
    });
    expect((await rows(t, "agentMemory"))[0]).toMatchObject({
      householdId: home,
      verifiedBy: "max",
    });
  });
});

describe("wording cards", () => {
  /**
   * purpose: Run tool calls for a new running request of pat's, through the runtime step.
   * @param t: (TestConvex) Harness.
   * @param home: (Id<"households">) Household.
   * @param calls: (Array<[string, object]>) Tool names and inputs.
   * @return: (Promise<Id<"agentRequests">>) The request (left succeeded, with a reply).
   */
  async function runRequest(
    t: TestConvex,
    home: Id<"households">,
    calls: Array<[string, object]>,
  ): Promise<Id<"agentRequests">> {
    const requestId = await insertRequest(t, home, { requestedBy: "pat", status: "running" });
    await t.mutation(internal.agentRuntime.executeToolCalls, {
      requestId,
      calls: calls.map(([name, input], i) => ({
        toolUseId: `${requestId}-${i}`,
        name,
        input: JSON.stringify(input),
      })),
    });
    await t.run(
      async (ctx) => await ctx.db.patch(requestId, { status: "succeeded", reply: "Done." }),
    );
    return requestId;
  }

  /**
   * purpose: The wording of one request in the transcript, as a caregiver reads it.
   * @param t: (TestConvex) Harness.
   * @param home: (Id<"households">) Household.
   * @param requestId: (Id<"agentRequests">) The request.
   * @param subject: (string) Who reads it (default pat).
   * @return: (Promise<unknown[] | undefined>) Its cards; undefined when the request is not there.
   */
  async function wordingOf(
    t: TestConvex,
    home: Id<"households">,
    requestId: Id<"agentRequests">,
    subject = "pat",
  ): Promise<unknown[] | undefined> {
    const items = await t
      .withIdentity({ subject })
      .query(api.agentRequests.transcript, { householdId: home });
    const item = items.find((i) => i.type === "request" && i.id === requestId);
    return item?.type === "request" ? item.wording : undefined;
  }

  const PILLS = {
    type: "medication",
    title: "Morning pills",
    display_label: "Morning pills",
    times: ["08:00", "20:00"],
  };

  test("add_task gives a card with the label, the display's time and the spoken sentence", async () => {
    const { t, home } = await makeWorld();
    const requestId = await runRequest(t, home, [["add_task", PILLS]]);
    const [task] = await rows(t, "tasks");
    expect(await wordingOf(t, home, requestId)).toEqual([
      {
        taskId: task!._id,
        label: "Morning pills",
        time: "8:00",
        sentence: "Time for Morning pills, at 8 o'clock. Press Done when you have taken them.",
      },
    ]);
  });

  test("the card is live: a later change shows, a written prompt is used as is", async () => {
    const { t, home } = await makeWorld();
    const first = await runRequest(t, home, [["add_task", PILLS]]);
    const [task] = await rows(t, "tasks");
    const second = await runRequest(t, home, [
      [
        "update_task",
        {
          task_id: task!._id,
          changes: { display_label: "Pills", spoken_prompt: "Pills now, please." },
        },
      ],
      ["update_task", { task_id: task!._id, changes: { title: "AM pills" } }],
    ]);
    const card = {
      taskId: task!._id,
      label: "Pills",
      time: "8:00",
      sentence: "Pills now, please.",
    };
    expect(await wordingOf(t, home, first)).toEqual([card]);
    expect(await wordingOf(t, home, second)).toEqual([card]);
  });

  test("an anytime task's card has no sentence", async () => {
    const { t, home } = await makeWorld();
    const requestId = await runRequest(t, home, [
      ["add_task", { type: "routine", title: "Water plants", display_label: "Water the plants" }],
    ]);
    expect(await wordingOf(t, home, requestId)).toEqual([
      expect.objectContaining({ label: "Water the plants", time: "Anytime", sentence: null }),
    ]);
  });

  test("a stopped task and a failed call have no card", async () => {
    const { t, home } = await makeWorld();
    const requestId = await runRequest(t, home, [
      ["add_task", PILLS],
      ["add_task", { type: "medication", title: "No time", display_label: "No time" }],
    ]);
    expect(await wordingOf(t, home, requestId)).toHaveLength(1);
    const [task] = await rows(t, "tasks");
    await runRequest(t, home, [["stop_task", { task_id: task!._id }]]);
    expect(await wordingOf(t, home, requestId)).toEqual([]);
  });

  test("a viewer gets no requests and so no cards", async () => {
    const { t, home } = await makeWorld();
    const requestId = await runRequest(t, home, [["add_task", PILLS]]);
    expect(await wordingOf(t, home, requestId, "val")).toBeUndefined();
    const items = await t
      .withIdentity({ subject: "val" })
      .query(api.agentRequests.transcript, { householdId: home });
    expect(items.every((i) => i.type === "post")).toBe(true);
  });
});
