import { describe, expect, test } from "vitest";
import { TASK_CAPS, clippedLabel } from "./taskDraft";

describe("clippedLabel", () => {
  test("keeps a label that fits", () => {
    expect(clippedLabel("Call the plumber")).toBe("Call the plumber");
    const exact = "a".repeat(TASK_CAPS.displayLabel);
    expect(clippedLabel(exact)).toBe(exact);
  });

  test("clips a long label at a word boundary and ends it with an ellipsis", () => {
    const label = clippedLabel(
      "Call the pharmacy about refilling my blood pressure pills before saturday",
    );
    expect(label).toBe("Call the pharmacy about refilling my blood pressure pills…");
    expect(label.length).toBeLessThanOrEqual(TASK_CAPS.displayLabel);
  });

  test("keeps a whole last word that ends right at the cut", () => {
    const words = `${"a".repeat(59)} bcd`;
    expect(clippedLabel(words)).toBe(`${"a".repeat(59)}…`);
    expect(clippedLabel(`${"a".repeat(58)} bcd efg`)).toBe(`${"a".repeat(58)}…`);
  });

  test("cuts mid-word only when a single word is longer than the cap", () => {
    const label = clippedLabel("x".repeat(70));
    expect(label).toBe(`${"x".repeat(59)}…`);
    expect(label.length).toBe(TASK_CAPS.displayLabel);
  });

  test("never leaves half of a surrogate pair before the ellipsis", () => {
    const label = clippedLabel(`${"x".repeat(58)}\u{1F600}${"y".repeat(10)}`);
    expect(label).toBe(`${"x".repeat(58)}…`);
  });
});
