// convex/profileLoader.test.ts
// Purpose: Tests for scripts/profileLoader.ts (the `profile-load` command's logic) against the
// real profile mutations in convex-test: the documented example file parses and loads every
// item, loading it again skips everything (no duplicates), an item the server refuses is
// reported as failed while the rest load, and parseProfileFile rejects malformed files with a
// message naming the problem. The test lives here, not in scripts/, because it needs the
// convex-test harness and Vite's import.meta.glob.
//
// Last modified: 2026-11-09

import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { loadProfile, parseProfileFile } from "../scripts/profileLoader";
import type { MutationCaller } from "../scripts/profileLoader";
import { createHousehold, makeBackend } from "./testing.helpers";
import type { TestConvex } from "./testing.helpers";

/** The example file, read through Vite so the test runs in the edge runtime. */
const EXAMPLE = Object.values(
  import.meta.glob("../scripts/profile.example.json", { eager: true, import: "default" }),
)[0];

/**
 * purpose: A mutation caller that runs public mutations by name as user_a, like the script does.
 * @param t: (TestConvex) Harness.
 * @return: (MutationCaller) The caller.
 */
function callerFor(t: TestConvex): MutationCaller {
  const asUser = t.withIdentity({ subject: "user_a" });
  return (fn, args) => asUser.mutation(makeFunctionReference<"mutation">(fn), args);
}

describe("loadProfile", () => {
  test("loads the example file once, then skips every item on a second run", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const file = parseProfileFile(EXAMPLE);
    const total = file.lifeProfile.length + file.sensitiveTopics.length + file.facts.length;
    expect(total).toBeGreaterThan(0);

    const first = await loadProfile(file, householdId, callerFor(t));
    expect(first.failed).toEqual([]);
    expect(first.added).toHaveLength(total);
    expect(first.added[0]).toBe(`${file.lifeProfile[0]!.category}: ${file.lifeProfile[0]!.name}`);

    const second = await loadProfile(file, householdId, callerFor(t));
    expect(second).toEqual({ added: [], skipped: first.added, failed: [] });

    const asUser = t.withIdentity({ subject: "user_a" });
    expect(await asUser.query(api.profile.listEntries, { householdId })).toHaveLength(
      file.lifeProfile.length,
    );
    expect(await asUser.query(api.profile.listTopics, { householdId })).toHaveLength(
      file.sensitiveTopics.length,
    );
    const memory = await asUser.query(api.profile.listMemory, { householdId });
    expect(memory).toHaveLength(file.facts.length);
    expect(memory.every((f) => f.verified && f.source === "caregiver")).toBe(true);
  });

  test("reports an item the server refuses and still loads the others", async () => {
    const t = makeBackend();
    const householdId = await createHousehold(t);
    const report = await loadProfile(
      { lifeProfile: [{ category: "person", name: "   " }], sensitiveTopics: [], facts: ["Ok"] },
      householdId,
      callerFor(t),
    );
    expect(report.added).toEqual(["fact: Ok"]);
    expect(report.failed).toEqual([{ item: "person:    ", error: "Name cannot be blank" }]);
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
    ["a topic without guidance", { sensitiveTopics: [{ topic: "T" }] }, '"guidance" must be text'],
    ["a fact that is not text", { facts: [1] }, "facts[0] must be text"],
  ])("rejects %s", (_label, raw, message) => {
    expect(() => parseProfileFile(raw)).toThrow(message);
  });
});
