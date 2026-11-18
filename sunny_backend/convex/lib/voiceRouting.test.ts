import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { MAX_FLAG_DETAIL_LENGTH, flagDetail, membersNamed } from "./voiceRouting";

describe("flagDetail", () => {
  test("keeps the first two sentences on one line", () => {
    expect(flagDetail("One.\n\nTwo!  Three? Four.")).toBe("One. Two!");
  });

  test("text without a sentence end is kept whole", () => {
    expect(flagDetail("  dizzy after lunch ")).toBe("dizzy after lunch");
  });

  test("a decimal is not a sentence end", () => {
    expect(flagDetail("Took 2.5 tablets. Then another. Then more.")).toBe(
      "Took 2.5 tablets. Then another.",
    );
  });

  test("a long sentence is cut to the hard cap", () => {
    const capped = flagDetail("word ".repeat(200));
    expect(capped.length).toBe(MAX_FLAG_DETAIL_LENGTH);
    expect(capped.endsWith("...")).toBe(true);
  });

  test("blank stays blank", () => {
    expect(flagDetail(" \n ")).toBe("");
  });
});

describe("membersNamed", () => {
  const member = (displayName: string): Doc<"householdMembers"> =>
    ({
      _id: displayName as unknown as Id<"householdMembers">,
      _creationTime: 0,
      householdId: "h" as Id<"households">,
      userId: displayName,
      role: "member",
      displayName,
    }) as Doc<"householdMembers">;

  test("matches the whole name or the first name, ignoring case", () => {
    const members = [member("Sarah Lee"), member("Bob"), member("Sarah")];
    expect(membersNamed(members, "sarah").map((m) => m.displayName)).toEqual([
      "Sarah Lee",
      "Sarah",
    ]);
    expect(membersNamed(members, "BOB").map((m) => m.displayName)).toEqual(["Bob"]);
    expect(membersNamed(members, " ")).toEqual([]);
    expect(membersNamed(members, "Tommy")).toEqual([]);
  });
});
