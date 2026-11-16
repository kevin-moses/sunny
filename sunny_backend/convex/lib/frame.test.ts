import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceState } from "./deviceState";
import { frameDoneTarget } from "./deviceState";
import {
  DEFAULT_SCREEN,
  DRAWABLE_SCREEN,
  FRAME_PAGES,
  FRAME_RENDERER_VERSION,
  buildFrameModel,
  drawFrame,
  frameEtag,
  isDrawableScreen,
  nowCardGeometry,
  renderFrame,
} from "./frame";
import type { Frame, Screen } from "./frame";
import {
  FRAME_CASES,
  FRAME_SCREENS,
  at,
  dayState,
  fixtureEvent,
  fixtureTask,
  stepsState,
} from "./frameFixtures.helpers";
import { FACE_DATA } from "./fonts/frameFontData";
import { PACKED_HEADER_BYTES, encodePacked, packBits, packPixels } from "./framePacked";
import { decodePacked, readPackedHeader } from "./framePackedDecoder.helpers";
import { encodePng } from "./framePng";
import { Path } from "./frameRaster";
import { breakLines, cleanText, fitText, measure } from "./frameText";

const GOLDENS = new URL("./frameGoldens/", import.meta.url);

const LARGEST_BUDGET_MS = 1500;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function caseState(name: string): DeviceState {
  const found = FRAME_CASES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no case ${name}`);
  return found.state;
}

function goldenName(name: string, page: string, screen: Screen): string {
  return `${name}-${page}-${screen.width}x${screen.height}x${screen.greys}.png`;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function expectSameFrame(actual: Frame, expected: Frame): void {
  expect([actual.width, actual.height, actual.greys]).toEqual([
    expected.width,
    expected.height,
    expected.greys,
  ]);
  expect(Buffer.from(actual.levels).equals(Buffer.from(expected.levels))).toBe(true);
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Buffer.from(digest).toString("hex");
}

describe("Path", () => {
  it("bounds only the points of the path, never the origin", () => {
    const path = new Path().moveTo(100, 100).lineTo(110, 100).lineTo(110, 110).close();
    expect([path.minX, path.minY, path.maxX, path.maxY]).toEqual([100, 100, 110, 110]);
  });
});

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
      const png = encodePng(renderFrame(stepsState(1), screen, "now"));
      writeFileSync(`${preview}/${goldenName("steps-second-step", "now", screen)}`, png);
    }
  });

  it("ties the goldens and the font data to the renderer version (MANIFEST.json)", async () => {
    const files = readdirSync(GOLDENS)
      .filter((f) => f.endsWith(".png"))
      .sort();
    const all = Buffer.concat(
      files.map((f) => Buffer.concat([Buffer.from(f), readFileSync(new URL(f, GOLDENS))])),
    );
    const now = {
      rendererVersion: FRAME_RENDERER_VERSION,
      goldens: await sha256(all),
      fontData: await sha256(Buffer.from(JSON.stringify(FACE_DATA))),
    };
    const manifest = new URL("MANIFEST.json", GOLDENS);
    let stored: typeof now | null = null;
    try {
      stored = JSON.parse(readFileSync(manifest, "utf8")) as typeof now;
    } catch {
      stored = null;
    }
    const changed =
      stored === null || stored.goldens !== now.goldens || stored.fontData !== now.fontData;
    if (update && changed) {
      expect(
        stored?.rendererVersion,
        "the picture changed: bump FRAME_RENDERER_VERSION before updating the goldens",
      ).not.toBe(FRAME_RENDERER_VERSION);
      writeFileSync(manifest, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    expect(
      stored,
      "goldens or font data changed without a FRAME_RENDERER_VERSION bump and update",
    ).toEqual(now);
  });
});

describe("the wall display's rules", () => {
  it("never draws an early task as Now: clear card, Next up, plain row, no Done", () => {
    const state = caseState("early-task");
    expect(state.now.task?.early).toBe(true);
    expect(state.done?.early).toBe(true);
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
    expect(frameDoneTarget(state)).toBeNull();
  });

  it("keeps an event that comes before the early task as Next up", () => {
    const model = buildFrameModel(caseState("early-after-event"), "now");
    expect(model).toMatchObject({
      now: { kind: "clear", allDone: false },
      next: { title: "Nurse Joan visits", when: "7:45", initial: "J", icon: null },
    });
  });

  it("makes the early task Next up when two rows share a label and a clock time", () => {
    const state = dayState("07:20", {
      tasks: [fixtureTask("pills", "08:15", "Morning pills", { confirmable: true })],
      eventsToday: [
        fixtureEvent("am", "07:10", "Nurse visits", null),
        fixtureEvent("pm", "19:10", "Nurse visits", null),
      ],
    });
    expect(state.rows.filter((r) => r.label === "Nurse visits" && r.time === "7:10")).toHaveLength(
      2,
    );
    expect(buildFrameModel(state, "now")).toMatchObject({
      next: { title: "Morning pills", when: "8:15" },
    });
  });

  it("draws an early task's frame exactly like the same day with nothing confirmable", () => {
    const early = caseState("early-task");
    const plain: DeviceState = {
      ...early,
      now: { kind: "clear", task: null, allDone: false },
      done: null,
      nextUp: early.nextUpAfterDue,
      rows: early.rows.map((r) => ({ ...r, mark: "none" })),
    };
    for (const page of FRAME_PAGES) {
      expectSameFrame(
        renderFrame(early, DEFAULT_SCREEN, page),
        renderFrame(plain, DEFAULT_SCREEN, page),
      );
    }
  });

  it("draws a due task as Now and names it for Done", () => {
    const state = caseState("due");
    expect(buildFrameModel(state, "now")).toMatchObject({
      now: { kind: "task", tab: "Now  \u00b7  8:00", label: "Morning pills", overdue: false },
      next: { title: "Walk around the block" },
    });
    expect(frameDoneTarget(state)).toEqual({ instanceId: "pills-am", early: false, step: 0 });
    expect(frameDoneTarget(caseState("snoozed"))?.instanceId).toBe("pills-am");
    expect(frameDoneTarget(caseState("nothing-due"))).toBeNull();
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

  it("is not all done on a day with only missed and done tasks and no event", () => {
    const state = dayState("21:00", {
      tasks: [
        fixtureTask("a", "08:00", "Morning pills", { state: "missed" }),
        fixtureTask("b", "12:00", "Lunch", { state: "confirmed" }),
      ],
    });
    expect(buildFrameModel(state, "now")).toMatchObject({ now: { kind: "clear", allDone: false } });
  });

  it("dims an event that is over", () => {
    const today = buildFrameModel(caseState("missed"), "today");
    const visit =
      today.page === "today" ? today.rows.find((r) => r.label === "Sarah visits") : null;
    expect(visit?.mark).toBe("past");
    const earlier = buildFrameModel(caseState("nothing-due"), "today");
    const coming =
      earlier.page === "today" ? earlier.rows.find((r) => r.label === "Sarah visits") : null;
    expect(coming?.mark).toBe("none");
  });

  it("writes Later on a snoozed task's tab and row, and Still to do on an overdue one", () => {
    expect(buildFrameModel(caseState("snoozed"), "now")).toMatchObject({
      now: { tab: "Later  \u00b7  8:00" },
    });
    const today = buildFrameModel(caseState("snoozed"), "today");
    expect(today.page === "today" && today.rows[0]!.mark).toBe("later");
    expect(buildFrameModel(caseState("overdue"), "now")).toMatchObject({
      now: { tab: "Still to do  \u00b7  8:00", overdue: true, icon: null },
    });
  });

  it("names a multi-step task on its tab, draws the state's step, and keeps overdue for Talk", () => {
    expect(buildFrameModel(stepsState(2), "now")).toMatchObject({
      now: {
        kind: "steps",
        tab: "Now  \u00b7  Getting ready to go out",
        step: 2,
        steps: ["Put on your coat", "Take your keys", "Lock the door"],
        overdue: false,
      },
    });
    expect(buildFrameModel(caseState("steps"), "now")).toMatchObject({ now: { step: 0 } });
    expect(buildFrameModel(caseState("overdue-steps"), "now")).toMatchObject({
      now: { kind: "steps", overdue: true, tab: "Still to do  \u00b7  Getting ready to go out" },
    });
  });

  it("draws exactly the state's rows and its hidden count", () => {
    const state = caseState("many-rows");
    const model = buildFrameModel(state, "today");
    expect(state.rowsHidden).toBeGreaterThan(0);
    expect(model).toMatchObject({
      rows: state.rows.map(({ time, label, mark }) => ({ time, label, mark })),
      hidden: state.rowsHidden,
    });
  });

  it("writes a dose in micrograms as mcg on the Now card and in rows", () => {
    const state = caseState("micro-dose");
    expect(buildFrameModel(state, "now")).toMatchObject({
      now: { label: "Vitamin B12 1000 mcg", pillDescription: "1 1/2 tablets, >= 8 oz water" },
      next: { title: "Vitamin D 25 mcg to with lunch" },
    });
  });

  it("falls back to the item's type when a label has nothing drawable", () => {
    const state = caseState("blank-label");
    expect(buildFrameModel(state, "now")).toMatchObject({
      now: { label: "Medication" },
      next: { title: "Event" },
    });
    const today = buildFrameModel(state, "today");
    expect(today.page === "today" && today.rows.map((r) => r.label)).toEqual([
      "Medication",
      "Event",
      "Call Koji",
    ]);
    const steps = dayState("10:05", {
      tasks: [
        fixtureTask("out", "10:00", "\u{1F6AA}", {
          type: "checklist",
          state: "due",
          checklistItems: ["Coat", "\u{1F511}"],
        }),
      ],
    });
    expect(buildFrameModel(steps, "now")).toMatchObject({
      now: { tab: "Now  \u00b7  Checklist", steps: ["Coat", "Step 2"] },
    });
  });
});

describe("layout: text stays in the Now card (generated cards)", () => {
  const words = (
    "go big pig yoga jog gym plug bring grey jumper glasses pills yellow tablet keep upright " +
    "quickly please pick up your keys gloves happy jelly gp extraordinarily Wolverhampton"
  ).split(" ");
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const phrase = (count: number): string =>
    Array.from({ length: count }, () => words[rnd(words.length)]).join(" ");
  const screens = [
    { width: 800, height: 480, greys: 2 },
    DEFAULT_SCREEN,
    { width: 1194, height: 834, greys: 4 },
    { width: 1600, height: 1000, greys: 16 },
    { width: DRAWABLE_SCREEN.minWidth, height: DRAWABLE_SCREEN.minHeight, greys: 2 },
    { width: 680, height: 960, greys: 4 },
  ];
  const card = (
    overdue: boolean,
    label: string,
    pill: string | null,
    steps: boolean,
  ): { overdue: boolean; state: DeviceState } => {
    const state = overdue ? "escalated" : "due";
    const task = steps
      ? fixtureTask("x", "08:00", label, {
          type: "checklist",
          state,
          checklistItems: [pill ?? "", "b"],
        })
      : fixtureTask("x", "08:00", label, { type: "medication", state, pillDescription: pill });
    return { overdue, state: dayState("08:40", { tasks: [task] }) };
  };
  const cards = [
    card(
      true,
      "glasses go please upright",
      "gloves jumper plug jelly bring yoga happy pick keep",
      false,
    ),
    card(
      true,
      "Blood pressure tablet and the yellow capsule",
      "One round pink tablet, big yellow gel capsule, keep upright",
      false,
    ),
    card(
      true,
      "Getting ready",
      "Put on your warm winter coat, gloves and a hat, and pick up your keys and glasses",
      true,
    ),
    ...Array.from({ length: 40 }, (_, n) =>
      n % 4 === 3
        ? card(rnd(2) === 0, phrase(1 + rnd(6)), phrase(4 + rnd(16)), true)
        : card(rnd(3) > 0, phrase(3 + rnd(8)), rnd(5) === 0 ? null : phrase(4 + rnd(12)), false),
    ),
  ];

  it("no text in the band above the prompts rule, none outside the card", () => {
    const hits: string[] = [];
    cards.forEach(({ overdue, state }, n) => {
      for (const screen of screens) {
        const frame = drawFrame(buildFrameModel(state, "now"), screen);
        const { box, inner, promptsTop } = nowCardGeometry(screen, overdue ? 2 : 1);
        const scale = Math.min(screen.width / 1194, screen.height / 834);
        const paper = screen.greys - 1;
        const blank = (x0: number, x1: number, y0: number, y1: number): boolean => {
          for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
              if (frame.levels[y * screen.width + x] !== paper) return false;
            }
          }
          return true;
        };
        const rule = Math.round(promptsTop);
        const band = Math.max(2, Math.floor(12 * scale));
        const left = Math.floor(inner.x);
        const right = Math.ceil(inner.x + inner.w);
        const boxRight = Math.round(box.x + box.w);
        const boxBottom = Math.round(box.y + box.h);
        const where = `card ${n} at ${screen.width}x${screen.height}`;
        if (!blank(left, right, rule - band, rule)) hits.push(`${where}: above the rule`);
        const gutter = Math.floor(box.x + box.w + 32 * scale);
        if (!blank(boxRight + 1, gutter, Math.round(box.y), boxBottom)) {
          hits.push(`${where}: right of the card`);
        }
        const stripTop = Math.floor(screen.height - 100 * scale);
        if (!blank(Math.round(box.x), boxRight, boxBottom + 1, stripTop - 1)) {
          hits.push(`${where}: below the card`);
        }
      }
    });
    expect(hits).toEqual([]);
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

  it("reads no clock: the same state draws the same frame whatever the clocks say", () => {
    const state = caseState("due");
    const date = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
    const perf = vi.spyOn(performance, "now").mockReturnValue(1);
    const first = encodePacked(renderFrame(state, DEFAULT_SCREEN, "today"));
    const firstNow = encodePacked(renderFrame(state, DEFAULT_SCREEN, "now"));
    date.mockReturnValue(Date.parse("2031-06-15T13:37:00Z"));
    perf.mockReturnValue(987654.321);
    const second = encodePacked(renderFrame(state, DEFAULT_SCREEN, "today"));
    const secondNow = encodePacked(renderFrame(state, DEFAULT_SCREEN, "now"));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(firstNow).equals(Buffer.from(secondNow))).toBe(true);
  });
});

describe("PNG", () => {
  it("is a valid greyscale PNG that inflates back to the frame, at every depth", async () => {
    const state = caseState("due");
    for (const greys of [2, 3, 4, 16, 256]) {
      const screen = { width: 501, height: 351, greys };
      const frame = renderFrame(state, screen, "now");
      const decoded = await decodePng(encodePng(frame), greys);
      expect(decoded.width).toBe(501);
      expect(decoded.height).toBe(351);
      expectSameFrame(decoded, frame);
    }
  });

  it("uses the bit depth that holds the levels exactly", () => {
    const depthOf = (greys: number): number =>
      encodePng(renderFrame(caseState("due"), { width: 500, height: 350, greys }, "now"))[24]!;
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
      renderFrame(caseState("due"), { width: 500, height: 350, greys: 16 }, "now"),
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

  it("splits literal runs of 129 bytes or more without ever writing the no-op count", () => {
    for (const length of [129, 130, 256, 300, 1000]) {
      const varied = Uint8Array.from({ length }, (_, i) => i % 2);
      const packed = packBits(varied);
      const controls: number[] = [];
      for (let i = 0; i < packed.length;) {
        const n = packed[i]!;
        controls.push(n);
        i += n < 128 ? n + 2 : 2;
      }
      expect(controls).not.toContain(128);
      expect(controls.every((n) => n < 128)).toBe(true);
      expect(packed.length).toBe(length + Math.ceil(length / 128));
    }
  });

  it("never exceeds raw + ceil(raw / 128) bytes, even for noise", () => {
    let seed = 11;
    const noise = Uint8Array.from({ length: 20000 }, () => {
      seed = (seed * 48271) % 2147483647;
      return seed % 3 === 0 ? 0xff : seed & 0xff;
    });
    expect(packBits(noise).length).toBeLessThanOrEqual(20000 + Math.ceil(20000 / 128));
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
      renderFrame(caseState("due"), { width: 500, height: 350, greys: 4 }, "now"),
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
    const today = buildFrameModel(state, "today");
    const rekeyed: DeviceState = { ...state, rows: state.rows.map((r) => ({ ...r, key: "x" })) };
    expect(frameEtag(buildFrameModel(rekeyed, "today"), DEFAULT_SCREEN, "png")).toBe(
      frameEtag(today, DEFAULT_SCREEN, "png"),
    );
  });

  it("leaves out the icon behind an initial and what a multi-step card does not draw", () => {
    const visit = caseState("early-after-event");
    const visitModel = buildFrameModel(visit, "now");
    const otherIcon: DeviceState = {
      ...visit,
      nextUpAfterDue: { ...visit.nextUpAfterDue!, icon: "bell" },
    };
    expect(frameEtag(buildFrameModel(otherIcon, "now"), DEFAULT_SCREEN, "png")).toBe(
      frameEtag(visitModel, DEFAULT_SCREEN, "png"),
    );
    const steps = caseState("steps");
    const task = steps.now.task!;
    const changed: DeviceState = {
      ...steps,
      now: {
        ...steps.now,
        task: {
          ...task,
          icon: "bell",
          question: "Taken them?",
          pillDescription: "x",
          time: "9:00",
        },
      },
    };
    expect(frameEtag(buildFrameModel(changed, "now"), DEFAULT_SCREEN, "png")).toBe(
      frameEtag(buildFrameModel(steps, "now"), DEFAULT_SCREEN, "png"),
    );
  });
});

describe("text", () => {
  const style = { face: "semiBold", size: 36, lineHeight: 43 } as const;

  it("writes out symbols whose meaning a missing glyph would lose", () => {
    expect(cleanText("Vitamin B12 1000 \u00b5g")).toBe("Vitamin B12 1000 mcg");
    expect(cleanText("25 \u03bcg")).toBe("25 mcg");
    expect(cleanText("\u2265 2 and \u2264 4")).toBe(">= 2 and <= 4");
    expect(cleanText("8am\u21929am")).toBe("8am to 9am");
    expect(cleanText("8am \u2192 9am")).toBe("8am to 9am");
    expect(cleanText("2 \u00d7 a day, 1\u00f72")).toBe("2 x a day, 1/2");
    expect(cleanText("1\u00bd, \u00bc and \u00be")).toBe("1 1/2, 1/4 and 3/4");
    expect(cleanText("Keep at 20\u00b0, 98.6\u2109")).toBe("Keep at 20\u00b0, 98.6\u00b0F");
    expect(cleanText("care\u00adful \u2212 5")).toBe("careful - 5");
  });

  it("keeps the letters of names the font lacks without their accents", () => {
    expect(cleanText("K\u014dji")).toBe("Koji");
    expect(cleanText("\u0108ar\u0125an")).toBe("Carhan");
    expect(cleanText("\u014ae\u0167")).toBe("Net");
  });

  it("keeps the meaning of compatibility characters: ligatures, wide digits, units, subscripts", () => {
    expect(cleanText("\ufb01nish")).toBe("finish");
    expect(cleanText("\uff11\uff12 mg")).toBe("12 mg");
    expect(cleanText("5\u338e")).toBe("5mg");
    expect(cleanText("50 \u338d")).toBe("50 mcg");
    expect(cleanText("H\u2082O")).toBe("H2O");
    expect(cleanText("Vit D\u2122")).toBe("Vit D");
  });

  it("drops what cannot be drawn: Chinese, emoji, whitespace runs", () => {
    expect(cleanText("\u65e9\u9910")).toBe("");
    expect(cleanText("\u{1F48A}\u{1F48A}")).toBe("");
    expect(cleanText("  Caf\u00e9 \u{1F48A}  with\n Ze\u0301lie  ")).toBe(
      "Caf\u00e9 with Z\u00e9lie",
    );
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
    expect(cut.lines[1]!.endsWith("\u2026")).toBe(true);
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

describe("screens", () => {
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
    expect(isDrawableScreen({ width: 600, height: 400, greys: 3.5 })).toBe(false);
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
