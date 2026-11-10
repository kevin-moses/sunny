// convex/profileLoader.test.ts
// Purpose: Tests for scripts/profileLoader.ts (the `profile-load` command's logic) against the
// real profile mutations in convex-test, called the way the CLI path calls them: a failure is
// turned into the stderr text `npx convex run` prints for a ConvexError and back through
// cliError, so the message the loader reports is the one a real run would show. Covers: the
// documented example file parses and loads every item; loading it again reports every item
// unchanged; an item stored with different text is reported "differs" and left alone, and with
// --update is replaced through the update mutations; a fact the senior had said is reported
// confirmed; an item the server refuses is reported failed with the server's message while the
// rest load; cliError reads the CLI's real stderr shape; parseProfileFile rejects malformed files,
// including unknown keys inside items. The test lives here, not in scripts/, because it needs the
// convex-test harness and Vite's import.meta.glob.
//
// Last modified: 2026-11-09

import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { cliError, loadProfile, parseProfileFile } from "../scripts/profileLoader";
import type { MutationCaller } from "../scripts/profileLoader";
import { createHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

/** The example file, read through Vite so the test runs in the edge runtime. */
const EXAMPLE = Object.values(
  import.meta.glob("../scripts/profile.example.json", { eager: true, import: "default" }),
)[0];

/**
 * purpose: What `npx convex run` writes to stderr when a function throws a ConvexError (copied
 *          from a real run against the dev deployment; colors are added when stderr is a TTY).
 * @param fn: (string) Function name.
 * @param data: (unknown) The ConvexError's data.
 * @return: (string) The stderr text.
 */
function cliStderr(fn: string, data: unknown): string {
  return [
    `✖ Failed to run function "${fn}":`,
    "\u001b[31mConvexError: [Request ID: 88dff8f9dd68bdcc] Server Error",
    `Uncaught ConvexError: ${JSON.stringify(data)}`,
    "    at appError (../../convex/lib/errors.ts:27:0)",
    "    at handler (../convex/profile.ts:108:12)\u001b[39m",
  ].join("\n");
}

/**
 * purpose: A mutation caller that runs public mutations by name as user_a, and fails the way
 *          the script's convexRun does (the CLI's stderr through cliError).
 * @param t: (TestConvex) Harness.
 * @return: (MutationCaller) The caller.
 */
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

/**
 * purpose: A household created by user_a.
 * @return: (Promise<{ t: TestConvex, householdId: Id<"households"> }>) The harness and household.
 */
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
        lifeProfile: [{ category: "person", name: "Sarah", details: "Daughter" }],
        sensitiveTopics: [{ topic: "money", guidance: "Old guidance" }],
        facts: [],
      },
      householdId,
      call,
    );
    const changed = {
      lifeProfile: [{ category: "person", name: "Sarah" }],
      sensitiveTopics: [{ topic: "money", guidance: "New guidance" }],
      facts: [],
    };
    const asUser = t.withIdentity({ subject: "user_a" });
    const stored = async () => ({
      entries: await asUser.query(api.profile.listEntries, { householdId }),
      topics: await asUser.query(api.profile.listTopics, { householdId }),
    });

    const plain = await loadProfile(changed, householdId, call);
    expect(plain.differs).toEqual(["person: Sarah", "topic: money"]);
    expect(plain.updated).toEqual([]);
    let now = await stored();
    expect(now.entries[0]!.details).toBe("Daughter");
    expect(now.topics[0]!.guidance).toBe("Old guidance");

    const updated = await loadProfile(changed, householdId, call, { update: true });
    expect(updated.updated).toEqual(["person: Sarah", "topic: money"]);
    expect(updated.differs).toEqual([]);
    now = await stored();
    expect(now.entries[0]!.details).toBeNull();
    expect(now.topics[0]!.guidance).toBe("New guidance");
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
      '✖ Failed to run function "profile:addEntry":',
      "ArgumentValidationError: Value does not match validator.",
    ].join("\n");
    expect(cliError(stderr, "fallback").message).toBe(
      "ArgumentValidationError: Value does not match validator.",
    );
    expect(cliError("", "fallback").message).toBe("fallback");
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
