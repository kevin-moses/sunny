import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { cliError, loadProfile, parseProfileFile } from "../scripts/profileLoader";
import type { MutationCaller } from "../scripts/profileLoader";
import { createHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

const EXAMPLE = Object.values(
  import.meta.glob("../scripts/profile.example.json", { eager: true, import: "default" }),
)[0];

function cliStderr(fn: string, data: unknown): string {
  return [
    `x Failed to run function "${fn}":`,
    "\u001b[31mConvexError: [Request ID: 88dff8f9dd68bdcc] Server Error",
    `Uncaught ConvexError: ${JSON.stringify(data)}`,
    "    at appError (../../convex/lib/errors.ts:27:0)",
    "    at handler (../convex/profile.ts:108:12)\u001b[39m",
  ].join("\n");
}

function callerFor(t: TestConvex): MutationCaller {
  const asUser = t.withIdentity({ subject: "user_a" });
  return async (fn, args) => {
    try {
      return await asUser.mutation(makeFunctionReference<"mutation">(fn), args);
    } catch (e) {
      if (!(e instanceof ConvexError)) throw e;
      throw cliError(cliStderr(fn, e.data), `npx convex run ${fn} failed`);
    }
  };
}

async function setup(): Promise<{ t: TestConvex; householdId: Id<"households"> }> {
  const t = makeBackend();
  return { t, householdId: await createHousehold(t) };
}

describe("loadProfile", () => {
  test("loads the example file once, then reports every item unchanged", async () => {
    const { t, householdId } = await setup();
    const file = parseProfileFile(EXAMPLE);
    const total = file.lifeProfile.length + file.sensitiveTopics.length + file.facts.length;
    expect(total).toBeGreaterThan(0);

    const first = await loadProfile(file, householdId, callerFor(t));
    expect(first.failed).toEqual([]);
    expect(first.added).toHaveLength(total);
    expect(first.added[0]).toBe(`${file.lifeProfile[0]!.category}: ${file.lifeProfile[0]!.name}`);

    const second = await loadProfile(file, householdId, callerFor(t));
    expect(second).toEqual({
      added: [],
      unchanged: first.added,
      confirmed: [],
      differs: [],
      updated: [],
      failed: [],
    });

    const asUser = t.withIdentity({ subject: "user_a" });
    expect(await asUser.query(api.profile.listEntries, { householdId })).toHaveLength(
      file.lifeProfile.length,
    );
    expect(await asUser.query(api.profile.listTopics, { householdId })).toHaveLength(
      file.sensitiveTopics.length,
    );
    const { facts } = await asUser.query(api.profile.listMemory, { householdId });
    expect(facts).toHaveLength(file.facts.length);
    expect(facts.every((f) => f.verified && f.source === "caregiver")).toBe(true);
  });

  test("reports changed text as differs and leaves it, and replaces it with --update", async () => {
    const { t, householdId } = await setup();
    const call = callerFor(t);
    await loadProfile(
      {
        lifeProfile: [
          { category: "person", name: "Sarah", details: "Daughter" },
          { category: "place", name: "Library", details: "Tuesdays" },
        ],
        sensitiveTopics: [{ topic: "money", guidance: "Old guidance" }],
        facts: [],
      },
      householdId,
      call,
    );
    const changed = {
      lifeProfile: [
        { category: "person", name: "Sarah", details: "Her daughter" },
        { category: "place", name: "Library", details: null },
      ],
      sensitiveTopics: [{ topic: "money", guidance: "New guidance" }],
      facts: [],
    };
    const asUser = t.withIdentity({ subject: "user_a" });
    const stored = async () => ({
      entries: await asUser.query(api.profile.listEntries, { householdId }),
      topics: await asUser.query(api.profile.listTopics, { householdId }),
    });

    const plain = await loadProfile(changed, householdId, call);
    expect(plain.differs).toEqual(["person: Sarah", "place: Library", "topic: money"]);
    expect(plain.updated).toEqual([]);
    let now = await stored();
    expect(now.entries.map((e) => e.details)).toEqual(["Daughter", "Tuesdays"]);
    expect(now.topics[0]!.guidance).toBe("Old guidance");

    const updated = await loadProfile(changed, householdId, call, { update: true });
    expect(updated.updated).toEqual([
      "person: Sarah",
      "place: Library (details cleared)",
      "topic: money",
    ]);
    expect(updated.differs).toEqual([]);
    now = await stored();
    expect(now.entries.map((e) => e.details)).toEqual(["Her daughter", null]);
    expect(now.topics[0]!.guidance).toBe("New guidance");
    const audit = await t.run(async (ctx) => await ctx.db.query("auditLog").collect());
    expect(
      audit.find((r) => r.action === "update" && r.entity === "sensitiveTopic")?.detail,
    ).toMatchObject({ previous: { guidance: "Old guidance" } });
  });

  test("an item without a details key keeps the stored details, even with --update", async () => {
    const { t, householdId } = await setup();
    const call = callerFor(t);
    const entry = { category: "person", name: "Sarah" };
    await loadProfile(
      { lifeProfile: [{ ...entry, details: "Daughter" }], sensitiveTopics: [], facts: [] },
      householdId,
      call,
    );
    const report = await loadProfile(
      { lifeProfile: [entry], sensitiveTopics: [], facts: [] },
      householdId,
      call,
      { update: true },
    );
    expect(report.unchanged).toEqual(["person: Sarah"]);
    const asUser = t.withIdentity({ subject: "user_a" });
    const entries = await asUser.query(api.profile.listEntries, { householdId });
    expect(entries[0]!.details).toBe("Daughter");
  });

  test("a refused update is reported as failed with an update: prefix", async () => {
    const { t, householdId } = await setup();
    const call = callerFor(t);
    await loadProfile(
      { lifeProfile: [], sensitiveTopics: [{ topic: "money", guidance: "Old" }], facts: [] },
      householdId,
      call,
    );
    const refusingUpdates: MutationCaller = (fn, args) => {
      if (fn !== "profile:updateTopic") return call(fn, args);
      throw cliError(cliStderr(fn, { code: "not_found", message: "Topic not found" }), "failed");
    };
    const report = await loadProfile(
      { lifeProfile: [], sensitiveTopics: [{ topic: "money", guidance: "New" }], facts: [] },
      householdId,
      refusingUpdates,
      { update: true },
    );
    expect(report.failed).toEqual([{ item: "topic: money", error: "update: Topic not found" }]);
    expect(report.updated).toEqual([]);
  });

  test("reports a fact the senior had said as confirmed", async () => {
    const { t, householdId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("agentMemory", { householdId, fact: "Likes tea", source: "senior" });
    });
    const report = await loadProfile(
      { lifeProfile: [], sensitiveTopics: [], facts: ["likes tea"] },
      householdId,
      callerFor(t),
    );
    expect(report.confirmed).toEqual(["fact: likes tea"]);
  });

  test("reports an item the server refuses with its message and still loads the others", async () => {
    const { t, householdId } = await setup();
    const report = await loadProfile(
      { lifeProfile: [{ category: "person", name: "   " }], sensitiveTopics: [], facts: ["Ok"] },
      householdId,
      callerFor(t),
    );
    expect(report.added).toEqual(["fact: Ok"]);
    expect(report.failed).toEqual([{ item: "person:    ", error: "Name cannot be blank" }]);
  });
});

describe("cliError", () => {
  test("takes the ConvexError message from the CLI's stderr", () => {
    const stderr = cliStderr("voice:livekitToken", {
      code: "unauthenticated",
      message: "Sign in first",
    });
    expect(cliError(stderr, "fallback").message).toBe("Sign in first");
  });

  test("falls back to the text after the header for other failures", () => {
    const stderr = [
      'x Failed to run function "profile:addEntry":',
      "ArgumentValidationError: Value does not match validator.",
    ].join("\n");
    expect(cliError(stderr, "fallback").message).toBe(
      "ArgumentValidationError: Value does not match validator.",
    );
    expect(cliError("", "fallback").message).toBe("fallback");
  });

  test("strips terminal color sequences and keeps any other escape", () => {
    const escape = String.fromCharCode(0x1b);
    const stderr = `${escape}[31mBoom${escape}[0m ${escape}[1;2mnow${escape}[q`;
    expect(cliError(stderr, "fallback").message).toBe(`Boom now${escape}[q`);
  });

  test("uses the raw text when the ConvexError payload is not JSON", () => {
    const stderr = "Uncaught ConvexError: {not json}";
    expect(cliError(stderr, "fallback").message).toBe("Uncaught ConvexError: {not json}");
  });

  test("uses the raw text when the ConvexError payload has no message", () => {
    const stderr = 'Uncaught ConvexError: {"code":"x"}';
    expect(cliError(stderr, "fallback").message).toBe('Uncaught ConvexError: {"code":"x"}');
  });
});

describe("parseProfileFile", () => {
  test("treats absent sections as empty and ignores underscore keys", () => {
    expect(parseProfileFile({ _note: "hi", facts: ["A"] })).toEqual({
      lifeProfile: [],
      sensitiveTopics: [],
      facts: ["A"],
    });
  });

  test("keeps a details key only when the item has one, null included", () => {
    const file = parseProfileFile({
      lifeProfile: [
        { category: "person", name: "A" },
        { category: "person", name: "B", details: null },
        { category: "person", name: "C", details: "x" },
      ],
    });
    expect(file.lifeProfile).toEqual([
      { category: "person", name: "A" },
      { category: "person", name: "B", details: null },
      { category: "person", name: "C", details: "x" },
    ]);
    expect("details" in file.lifeProfile[0]!).toBe(false);
  });

  test.each([
    ["not an object", [], "JSON object"],
    ["an unknown key", { lifeprofile: [] }, 'Unknown key "lifeprofile"'],
    ["a section that is not a list", { facts: "A" }, '"facts" must be a list'],
    ["an entry that is not an object", { lifeProfile: ["Sarah"] }, "lifeProfile[0] must be"],
    ["an unknown category", { lifeProfile: [{ category: "pet", name: "Rex" }] }, "category"],
    ["a missing name", { lifeProfile: [{ category: "person" }] }, '"name" must be text'],
    [
      "non-text details",
      { lifeProfile: [{ category: "person", name: "A", details: 3 }] },
      "details",
    ],
    [
      "a misspelled entry key",
      { lifeProfile: [{ category: "person", name: "A", detials: "x" }] },
      'lifeProfile[0]: unknown key "detials"',
    ],
    [
      "a misspelled topic key",
      { sensitiveTopics: [{ topic: "T", guidance: "G", guidence: "x" }] },
      'sensitiveTopics[0]: unknown key "guidence"',
    ],
    ["a topic without guidance", { sensitiveTopics: [{ topic: "T" }] }, '"guidance" must be text'],
    ["a fact that is not text", { facts: [1] }, "facts[0] must be text"],
  ])("rejects %s", (_label, raw, message) => {
    expect(() => parseProfileFile(raw)).toThrow(message);
  });
});
