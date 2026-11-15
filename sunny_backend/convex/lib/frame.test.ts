// lib/frame.test.ts
// Purpose: Tests for the server-drawn display frames (lib/frame.ts, frameRaster.ts,
// frameText.ts, framePng.ts, framePacked.ts).
// Goldens: every case of lib/frameFixtures.helpers.ts, both pages, at 960 x 680 x 4 and
// 800 x 480 x 2, must encode to exactly the PNG stored in lib/frameGoldens/. After an intended
// drawing change, regenerate them with
//   FRAME_GOLDENS=update npx vitest run convex/lib/frame.test.ts
// and look at the new files before committing them. FRAME_PREVIEW_DIR=<dir> also writes every
// golden there (with a step-2 variant of the multi-step case).
// Rules: an early task is never drawn as Now (clear card, plain row, Next up); a missed task
// keeps the card at "Nothing to do right now."; a snoozed task's tab says Later; the step shown
// is clamped. Determinism: two renders are byte-identical and no clock is read. Encoders: the
// PNG is valid (signature, IHDR, CRCs, zlib stream inflated by the platform's
// DecompressionStream back to the frame's samples); the packed format's header fields, row
// padding, PackBits (the TIFF specification's example) and the round trip through the decoder,
// raw encoding included, and refusals of malformed files. ETag inputs: page, format, screen and
// renderer version change it; a state change that draws nothing does not. Text: cleaning,
// wrapping, truncation with "…", shrinking to fit. Layout scales to other sizes. Time: the
// largest drawable screen renders within a budget.
//
// Last modified: 2026-11-14

import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceState } from "./deviceState";
import {
  DEFAULT_SCREEN,
  DRAWABLE_SCREEN,
  FRAME_PAGES,
  FRAME_RENDERER_VERSION,
  buildFrameModel,
  frameEtag,
  isDrawableScreen,
  renderFrame,
} from "./frame";
import type { Frame, FrameModel, Screen } from "./frame";
import { FRAME_CASES, FRAME_SCREENS, at } from "./frameFixtures.helpers";
import {
  PACKED_HEADER_BYTES,
  decodePacked,
  encodePacked,
  packBits,
  packPixels,
  readPackedHeader,
} from "./framePacked";
import { encodePng } from "./framePng";
import { Path } from "./frameRaster";
import { breakLines, cleanText, fitText, measure } from "./frameText";

describe("Path", () => {
  it("bounds only the points of the path, never the origin", () => {
    const path = new Path().moveTo(100, 100).lineTo(110, 100).lineTo(110, 110).close();
    expect([path.minX, path.minY, path.maxX, path.maxY]).toEqual([100, 100, 110, 110]);
  });
});

/** Where the goldens live. */
const GOLDENS = new URL("./frameGoldens/", import.meta.url);

/** Budget (ms) for drawing and encoding the largest drawable screen (measured: about 150). */
const LARGEST_BUDGET_MS = 1500;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * purpose: A golden case's state by name.
 * @param name: (string) The case.
 * @return: (DeviceState) Its state.
 */
function caseState(name: string): DeviceState {
  const found = FRAME_CASES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no case ${name}`);
  return found.state;
}

/**
 * purpose: The file name of a golden.
 * @param name: (string) Case name.
 * @param page: (string) Page.
 * @param screen: (Screen) Screen.
 * @return: (string) The file name.
 */
function goldenName(name: string, page: string, screen: Screen): string {
  return `${name}-${page}-${screen.width}x${screen.height}x${screen.greys}.png`;
}

/**
 * purpose: Inflate a zlib stream with the platform's DecompressionStream.
 * @param data: (Uint8Array) The stream.
 * @return: (Promise<Uint8Array>) The inflated bytes.
 */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * purpose: Decode a greyscale PNG made by encodePng back to levels, checking its structure.
 * @param png: (Uint8Array) The file.
 * @param greys: (number) The frame's grey count (to map 8-bit samples back to levels).
 * @return: (Promise<Frame>) The frame.
 */
async function decodePng(png: Uint8Array, greys: number): Promise<Frame> {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  const idat: Uint8Array[] = [];
  const types: string[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    types.push(type);
    expect(view.getUint32(offset + 8 + length)).toBe(
      crc32(png.subarray(offset + 4, offset + 8 + length)),
    );
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      depth = data[8]!;
      expect([...data.subarray(9)]).toEqual([0, 0, 0, 0]);
    }
    if (type === "IDAT") idat.push(data);
    offset += length + 12;
  }
  expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
  const raw = await inflate(idat[0]!);
  const rowBytes = Math.ceil((width * depth) / 8);
  expect(raw.length).toBe(height * (rowBytes + 1));
  const levels = new Uint8Array(width * height);
  const max = (1 << depth) - 1;
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (rowBytes + 1)]).toBe(0);
    for (let x = 0; x < width; x += 1) {
      const bit = x * depth;
      const sample = (raw[y * (rowBytes + 1) + 1 + (bit >> 3)]! >> (8 - depth - (bit & 7))) & max;
      levels[y * width + x] =
        depth === 8 && greys !== 256 ? Math.round((sample * (greys - 1)) / 255) : sample;
    }
  }
  return { width, height, greys, levels };
}

/**
 * purpose: CRC-32, written again here so the test does not trust the encoder's own.
 * @param data: (Uint8Array) Bytes.
 * @return: (number) The CRC.
 */
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * purpose: Expect two frames to be the same (size, greys, every level), compared as bytes
 *          because a deep comparison of 650,000 levels is very slow.
 * @param actual: (Frame) The frame made.
 * @param expected: (Frame) The frame wanted.
 * @return: (void)
 */
function expectSameFrame(actual: Frame, expected: Frame): void {
  expect([actual.width, actual.height, actual.greys]).toEqual([
    expected.width,
    expected.height,
    expected.greys,
  ]);
  expect(Buffer.from(actual.levels).equals(Buffer.from(expected.levels))).toBe(true);
}

describe("goldens", () => {
  const update = process.env.FRAME_GOLDENS === "update";
  const preview = process.env.FRAME_PREVIEW_DIR;
  for (const { name, state } of FRAME_CASES) {
    for (const screen of FRAME_SCREENS) {
      for (const page of FRAME_PAGES) {
        const file = goldenName(name, page, screen);
        it(`${file} matches its golden`, () => {
          const png = encodePng(renderFrame(state, screen, page));
          if (preview !== undefined) writeFileSync(`${preview}/${file}`, png);
          if (update) writeFileSync(new URL(file, GOLDENS), png);
          const golden = new Uint8Array(readFileSync(new URL(file, GOLDENS)));
          expect(
            Buffer.from(png).equals(Buffer.from(golden)),
            `${file} differs from its golden`,
          ).toBe(true);
        });
      }
    }
  }

  it("writes a preview of the multi-step task on its second step when asked", () => {
    if (preview === undefined) return;
    for (const screen of FRAME_SCREENS) {
      const png = encodePng(renderFrame(caseState("steps"), screen, "now", 1));
      writeFileSync(`${preview}/${goldenName("steps-second-step", "now", screen)}`, png);
    }
  });
});

describe("the wall display's rules", () => {
  it("never draws an early task as Now: clear card, Next up, plain row", () => {
    const state = caseState("early-task");
    expect(state.now.task?.early).toBe(true);
    const now = buildFrameModel(state, "now");
    expect(now).toMatchObject({
      now: { kind: "clear", allDone: false },
      next: { title: "Morning pills", when: "8:00", icon: "pills", initial: null },
    });
    const today = buildFrameModel(state, "today");
    expect(today.page === "today" && today.rows.map((r) => r.mark)).toEqual([
      "none",
      "none",
      "none",
      "none",
      "none",
    ]);
    expect(state.rows[0]!.mark).toBe("now");
  });

  it("keeps an event that comes before the early task as Next up", () => {
    const model = buildFrameModel(caseState("early-after-event"), "now");
    expect(model).toMatchObject({
      now: { kind: "clear", allDone: false },
      next: { title: "Nurse Joan visits", when: "7:45", initial: "J" },
    });
  });

  it("draws an early task's frame exactly like the same day with nothing confirmable", () => {
    const early = caseState("early-task");
    const plain: DeviceState = {
      ...early,
      now: { kind: "clear", task: null, allDone: false },
      done: null,
      nextUp: { title: "Morning pills", when: "8:00", icon: "pills", initial: null },
      rows: early.rows.map((r) => ({ ...r, mark: "none" })),
    };
    for (const page of FRAME_PAGES) {
      expectSameFrame(
        renderFrame(early, DEFAULT_SCREEN, page),
        renderFrame(plain, DEFAULT_SCREEN, page),
      );
    }
  });

  it("draws a due task as Now", () => {
    expect(buildFrameModel(caseState("due"), "now")).toMatchObject({
      now: { kind: "task", tab: "Now  ·  8:00", label: "Morning pills", overdue: false },
      next: { title: "Walk around the block" },
    });
  });

  it("keeps a day with a missed task at nothing to do, never all done", () => {
    const state = caseState("missed");
    expect(buildFrameModel(state, "now")).toMatchObject({ now: { kind: "clear", allDone: false } });
    const today = buildFrameModel(state, "today");
    expect(today.page === "today" && today.rows[0]!.mark).toBe("missed");
    expect(buildFrameModel(caseState("all-done-night"), "now")).toMatchObject({
      now: { kind: "clear", allDone: true },
    });
  });

  it("writes Later on a snoozed task's tab and Still to do on an overdue one", () => {
    expect(buildFrameModel(caseState("snoozed"), "now")).toMatchObject({
      now: { tab: "Later  ·  8:00" },
    });
    expect(buildFrameModel(caseState("overdue"), "now")).toMatchObject({
      now: { tab: "Still to do  ·  8:00", overdue: true },
    });
  });

  it("names a multi-step task on its tab and clamps the step shown", () => {
    const state = caseState("steps");
    expect(buildFrameModel(state, "now", 9)).toMatchObject({
      now: {
        tab: "Now  ·  Getting ready to go out",
        step: 2,
        steps: ["Put on your coat", "Take your keys", "Lock the door"],
      },
    });
    expect(buildFrameModel(state, "now", -3)).toMatchObject({ now: { step: 0 } });
  });

  it("draws exactly the state's rows and its hidden count", () => {
    const state = caseState("many-rows");
    const model = buildFrameModel(state, "today");
    expect(state.rowsHidden).toBeGreaterThan(0);
    expect(model).toMatchObject({ rows: state.rows, hidden: state.rowsHidden });
  });
});

describe("determinism", () => {
  it("two renders of every case are byte-identical", () => {
    for (const { state } of FRAME_CASES) {
      for (const screen of FRAME_SCREENS) {
        const first = encodePng(renderFrame(state, screen, "now"));
        const second = encodePng(renderFrame(state, screen, "now"));
        expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
      }
    }
  });

  it("reads no clock: the same state draws the same frame at any time", () => {
    const state = caseState("due");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = encodePacked(renderFrame(state, DEFAULT_SCREEN, "today"));
    vi.setSystemTime(new Date("2031-06-15T13:37:00Z"));
    const second = encodePacked(renderFrame(state, DEFAULT_SCREEN, "today"));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});

describe("PNG", () => {
  it("is a valid greyscale PNG that inflates back to the frame, at every depth", async () => {
    const state = caseState("due");
    for (const greys of [2, 3, 4, 16, 256]) {
      const screen = { width: 323, height: 241, greys };
      const frame = renderFrame(state, screen, "now");
      const decoded = await decodePng(encodePng(frame), greys);
      expect(decoded.width).toBe(323);
      expect(decoded.height).toBe(241);
      expectSameFrame(decoded, frame);
    }
  });

  it("uses the bit depth that holds the levels exactly", () => {
    const depthOf = (greys: number): number =>
      encodePng(renderFrame(caseState("due"), { width: 200, height: 150, greys }, "now"))[24]!;
    expect([2, 3, 4, 16, 17, 256].map(depthOf)).toEqual([1, 8, 2, 4, 8, 8]);
  });
});

describe("packed format", () => {
  it("has the documented header", () => {
    const frame = renderFrame(caseState("due"), DEFAULT_SCREEN, "now");
    const bytes = encodePacked(frame);
    expect([...bytes.subarray(0, 8)]).toEqual([0x53, 0x4e, 0x59, 0x46, 1, 2, 1, 3]);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(8, true)).toBe(960);
    expect(view.getUint16(10, true)).toBe(680);
    expect(view.getUint32(12, true)).toBe(bytes.length - PACKED_HEADER_BYTES);
    const small = encodePacked(
      renderFrame(caseState("due"), { width: 800, height: 480, greys: 2 }, "now"),
    );
    expect([...small.subarray(4, 8)]).toEqual([1, 1, 1, 1]);
    const many = encodePacked(
      renderFrame(caseState("due"), { width: 200, height: 150, greys: 16 }, "now"),
    );
    expect([...many.subarray(4, 8)]).toEqual([1, 4, 1, 15]);
  });

  it("round-trips every golden case through the decoder", () => {
    for (const { state } of FRAME_CASES) {
      for (const screen of FRAME_SCREENS) {
        for (const page of FRAME_PAGES) {
          const frame = renderFrame(state, screen, page);
          expectSameFrame(decodePacked(encodePacked(frame)), frame);
        }
      }
    }
  });

  it("packs pixels most significant bits first and pads each row with 1 bits", () => {
    const frame: Frame = {
      width: 5,
      height: 2,
      greys: 4,
      levels: Uint8Array.from([0, 1, 2, 3, 0, 3, 3, 3, 3, 1]),
    };
    expect([...packPixels(frame)]).toEqual([0b00011011, 0b00111111, 0b11111111, 0b01111111]);
    expectSameFrame(decodePacked(encodePacked(frame)), frame);
    const odd: Frame = { width: 161, height: 3, greys: 3, levels: new Uint8Array(483).fill(2) };
    expectSameFrame(decodePacked(encodePacked(odd)), odd);
  });

  it("encodes runs with PackBits exactly as the TIFF specification's example", () => {
    const input = Uint8Array.from([
      0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0x22, 0xaa,
      0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    ]);
    expect([...packBits(input)]).toEqual([
      0xfe, 0xaa, 0x02, 0x80, 0x00, 0x2a, 0xfd, 0xaa, 0x03, 0x80, 0x00, 0x2a, 0x22, 0xf7, 0xaa,
    ]);
    const long = new Uint8Array(1000).fill(7);
    expect(packBits(long).length).toBe(16);
  });

  it("decodes a raw payload and a no-op control byte", () => {
    const frame: Frame = {
      width: 8,
      height: 1,
      greys: 2,
      levels: Uint8Array.from([0, 1, 0, 1, 1, 1, 1, 1]),
    };
    const raw = Uint8Array.from([
      0x53, 0x4e, 0x59, 0x46, 1, 1, 0, 1, 8, 0, 1, 0, 1, 0, 0, 0, 0b01011111,
    ]);
    expectSameFrame(decodePacked(raw), frame);
    const noop = Uint8Array.from([
      0x53, 0x4e, 0x59, 0x46, 1, 1, 1, 1, 8, 0, 1, 0, 3, 0, 0, 0, 0x80, 0x00, 0x5f,
    ]);
    expectSameFrame(decodePacked(noop), frame);
  });

  it("refuses malformed files", () => {
    const good = encodePacked(
      renderFrame(caseState("due"), { width: 200, height: 150, greys: 4 }, "now"),
    );
    const broken = (patch: (b: Uint8Array) => Uint8Array): Uint8Array => patch(good.slice());
    expect(() => decodePacked(broken((b) => ((b[0] = 0), b)))).toThrow("not a packed frame");
    expect(() => decodePacked(broken((b) => ((b[4] = 2), b)))).toThrow("version");
    expect(() => decodePacked(broken((b) => ((b[5] = 3), b)))).toThrow("bits per pixel");
    expect(() => decodePacked(broken((b) => ((b[7] = 9), b)))).toThrow("more levels");
    expect(() => decodePacked(broken((b) => b.subarray(0, b.length - 1)))).toThrow("bad length");
    expect(() => readPackedHeader(broken((b) => b.subarray(0, 10)))).toThrow("not a packed frame");
    const truncated = good.slice(0, good.length - 2);
    new DataView(truncated.buffer).setUint32(12, truncated.length - PACKED_HEADER_BYTES, true);
    expect(() => decodePacked(truncated)).toThrow();
  });
});

describe("frameEtag", () => {
  const state = caseState("due");
  const model = buildFrameModel(state, "now");
  const base = frameEtag(model, DEFAULT_SCREEN, "png");

  it("is the same for the same inputs", () => {
    expect(frameEtag(buildFrameModel(state, "now"), { ...DEFAULT_SCREEN }, "png")).toBe(base);
  });

  it("changes with the page, the format, each screen field and a drawn change", () => {
    const tags = [
      frameEtag(buildFrameModel(state, "today"), DEFAULT_SCREEN, "png"),
      frameEtag(model, DEFAULT_SCREEN, "packed"),
      frameEtag(model, { ...DEFAULT_SCREEN, width: 961 }, "png"),
      frameEtag(model, { ...DEFAULT_SCREEN, height: 681 }, "png"),
      frameEtag(model, { ...DEFAULT_SCREEN, greys: 2 }, "png"),
      frameEtag(buildFrameModel(caseState("overdue"), "now"), DEFAULT_SCREEN, "png"),
    ];
    expect(new Set([base, ...tags]).size).toBe(tags.length + 1);
  });

  it("includes the renderer version", () => {
    expect(frameEtag(model, DEFAULT_SCREEN, "png", FRAME_RENDERER_VERSION)).toBe(base);
    expect(frameEtag(model, DEFAULT_SCREEN, "png", FRAME_RENDERER_VERSION + 1)).not.toBe(base);
  });

  it("does not change when only undrawn parts of the state change", () => {
    const later: DeviceState = { ...state, version: "other", generatedAt: at("08:11"), cues: [] };
    expect(frameEtag(buildFrameModel(later, "now"), DEFAULT_SCREEN, "png")).toBe(base);
  });
});

describe("text", () => {
  const style = { face: "semiBold", size: 36, lineHeight: 43 } as const;

  it("cleans household text: NFC, undrawable characters left out, whitespace collapsed", () => {
    expect(cleanText("  Café \u{1F48A}  with\n Zélie  ")).toBe("Café with Zélie");
    expect(cleanText("\u{1F600}")).toBe("");
  });

  it("wraps at spaces and ends a cut last line with an ellipsis", () => {
    const text = "Blood pressure tablet with a full glass of water";
    const width = measure("Blood pressure tablet", style) + 1;
    expect(breakLines(text, style, width, 5).lines).toEqual([
      "Blood pressure tablet",
      "with a full glass of",
      "water",
    ]);
    const cut = breakLines(text, style, width, 2);
    expect(cut.truncated).toBe(true);
    expect(cut.lines[0]).toBe("Blood pressure tablet");
    expect(cut.lines[1]!.endsWith("…")).toBe(true);
    expect(measure(cut.lines[1]!, style)).toBeLessThanOrEqual(width);
  });

  it("breaks a word wider than the line between characters", () => {
    const { lines } = breakLines("Abernathy-Whitfield", style, measure("Aberna", style) + 0.5, 9);
    expect(lines[0]).toBe("Aberna");
    expect(lines.join("")).toBe("Abernathy-Whitfield");
  });

  it("starts no line with a space after a one-character word wider than the line", () => {
    const { lines } = breakLines("W is wide", style, measure("W", style) - 1, 9);
    expect(lines[0]).toBe("W");
    expect(lines.every((l) => !l.startsWith(" "))).toBe(true);
  });

  it("shrinks to fit before truncating, down to the minimum scale", () => {
    const big = { face: "extraBold", size: 72, lineHeight: 79 } as const;
    const width = measure("Morning pills", big) - 4;
    const fitted = fitText("Morning pills", big, 0.7, width, 1);
    expect(fitted.truncated).toBe(false);
    expect(fitted.style.size).toBeLessThan(72);
    const long = fitText("A very long label that cannot fit on one line", big, 0.7, width, 1);
    expect(long.truncated).toBe(true);
    expect(long.style.size).toBeCloseTo(72 * 0.7);
  });
});

describe("layout on other screens", () => {
  it("draws every case on portrait, small, large and many-grey screens", () => {
    const screens = [
      { width: 680, height: 960, greys: 4 },
      { width: DRAWABLE_SCREEN.minWidth, height: DRAWABLE_SCREEN.minHeight, greys: 2 },
      { width: 1872, height: 1404, greys: 16 },
      { width: 1200, height: 825, greys: 256 },
    ];
    for (const screen of screens) {
      for (const { state } of FRAME_CASES) {
        for (const page of FRAME_PAGES) {
          const frame = renderFrame(state, screen, page);
          expect(frame.levels.length).toBe(screen.width * screen.height);
          expect(Math.max(...frame.levels.subarray(0, 1000))).toBe(screen.greys - 1);
          expect(frame.levels.includes(0)).toBe(true);
        }
      }
    }
  });

  it("refuses screens outside the drawable range", () => {
    expect(DRAWABLE_SCREEN).toEqual({
      minWidth: 478,
      minHeight: 334,
      maxWidth: 2048,
      maxHeight: 2048,
    });
    expect(isDrawableScreen(DEFAULT_SCREEN)).toBe(true);
    expect(isDrawableScreen({ width: 478, height: 334, greys: 2 })).toBe(true);
    expect(isDrawableScreen({ width: 2049, height: 600, greys: 4 })).toBe(false);
    expect(isDrawableScreen({ width: 477, height: 600, greys: 4 })).toBe(false);
    expect(isDrawableScreen({ width: 600, height: 333, greys: 4 })).toBe(false);
    expect(isDrawableScreen({ width: 600, height: 400, greys: 1 })).toBe(false);
    expect(isDrawableScreen({ width: 600.5, height: 400, greys: 4 })).toBe(false);
  });
});

describe("render time", () => {
  it(`draws and encodes the largest drawable screen within ${LARGEST_BUDGET_MS} ms`, () => {
    const screen = {
      width: DRAWABLE_SCREEN.maxWidth,
      height: DRAWABLE_SCREEN.maxHeight,
      greys: 256,
    };
    const state = caseState("long-label");
    renderFrame(state, DEFAULT_SCREEN, "now");
    const start = performance.now();
    const frame = renderFrame(state, screen, "now");
    encodePng(frame);
    encodePacked(frame);
    expect(performance.now() - start).toBeLessThan(LARGEST_BUDGET_MS);
  });
});
