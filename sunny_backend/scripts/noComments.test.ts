import { describe, expect, test } from "vitest";
import { findComments } from "./noComments";

function lines(fileName: string, text: string): number[] {
  return findComments(fileName, text).map((comment) => comment.line);
}

describe("findComments", () => {
  test("finds line, block, doc, trailing and end-of-file comments", () => {
    const text = [
      "// TODO for now",
      "/* block */",
      "/** doc */",
      "export const a = 1; // trailing",
      "const b = /* inline */ 2;",
      "export const c = b;",
      "// last",
    ].join("\n");
    expect(lines("x.ts", text)).toEqual([1, 2, 3, 4, 5, 7]);
  });

  test("finds suppression pragmas", () => {
    const text = [
      "// eslint-disable-next-line no-console",
      "console.log(1);",
      "// @ts-expect-error",
      "const n: number = 'x';",
      "/* eslint-disable */",
    ].join("\n");
    expect(findComments("x.ts", text).map((comment) => comment.text)).toEqual([
      "// eslint-disable-next-line no-console",
      "// @ts-expect-error",
      "/* eslint-disable */",
    ]);
  });

  test("finds a JSX comment and leaves JSX text alone", () => {
    const text = [
      "export const A = () => (",
      "  <View>",
      "    {/* hidden for now */}",
      "    <Text>// not a comment /* either */</Text>",
      "  </View>",
      ");",
    ].join("\n");
    expect(lines("x.tsx", text)).toEqual([3]);
  });

  test("leaves strings, templates, regexes and division alone", () => {
    const text = [
      'const url = "https://example.com/* x */";',
      "const host = 'h';",
      "const t = `${host}//path /* x */ ${host}`;",
      "const r = /\\/\\/ x/;",
      "const d = 6 / 2 / 3;",
      "export { url, t, r, d };",
    ].join("\n");
    expect(findComments("x.ts", text)).toEqual([]);
  });

  test.each([
    ["x.ts", "type T = {\n  a: string; // member\n};"],
    ["x.ts", "interface I {\n  /* field */ b: number;\n}"],
    ["x.ts", "class C {\n  @dec // after decorator\n  m() {}\n}"],
    ["x.ts", "const o = { a: 1 /* value */ };"],
    ["x.ts", "// only a comment"],
    ["x.d.ts", "declare const v: string; // declared"],
    ["x.tsx", "const e = <View\n  a={1} // between attributes\n  b={2}\n/>;"],
  ])("finds a comment in %s: %s", (fileName, text) => {
    expect(findComments(fileName, text)).toHaveLength(1);
  });

  test("reads plain JavaScript", () => {
    expect(lines("x.js", "module.exports = {};\n// config note\n")).toEqual([2]);
  });
});
