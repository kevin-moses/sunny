import { describe, expect, test } from "vitest";
import { MAX_BODY_CHARS, shownBody } from "./mailBody";

describe("shownBody", () => {
  test("a body within the limit is shown whole", () => {
    expect(shownBody("Hello")).toEqual({ text: "Hello", cutNote: null });
    const atLimit = "a".repeat(MAX_BODY_CHARS);
    expect(shownBody(atLimit)).toEqual({ text: atLimit, cutNote: null });
  });

  test("a long body is cut at a paragraph boundary and says so", () => {
    const paragraph = `${"The clinic newsletter has more news. ".repeat(40).trim()}\n\n`;
    const text = paragraph.repeat(40);
    expect(text.length).toBeGreaterThan(MAX_BODY_CHARS);
    const shown = shownBody(text);
    expect(shown.text.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(text.startsWith(shown.text)).toBe(true);
    expect(text.slice(shown.text.length).startsWith("\n\n")).toBe(true);
    expect(shown.cutNote).toBe(
      `The body was cut after ${MAX_BODY_CHARS} characters; the rest is not shown.`,
    );
  });

  test("a long body whose only paragraph break is near the start is cut at a space", () => {
    const shown = shownBody(`Hello\n\n${"word ".repeat(MAX_BODY_CHARS)}`);
    expect(shown.text.length).toBeGreaterThan(MAX_BODY_CHARS - 10);
    expect(shown.text.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(shown.text.endsWith("word")).toBe(true);
  });

  test("a long body with no break at all is cut at the limit", () => {
    const shown = shownBody("x".repeat(MAX_BODY_CHARS + 50));
    expect(shown.text).toBe("x".repeat(MAX_BODY_CHARS));
  });
});
