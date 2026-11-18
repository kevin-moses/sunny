import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FONT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../sunny_app/node_modules/@expo-google-fonts",
);

const MAX_COMPOSITE_DEPTH = 8;

const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../convex/lib/fonts/frameFontData.ts",
);

const FACES: Record<string, { pkg: string; file: string }> = {
  serifBold: { pkg: "literata", file: "700Bold/Literata_700Bold.ttf" },
  serifMedium: { pkg: "literata", file: "500Medium/Literata_500Medium.ttf" },
  regular: {
    pkg: "atkinson-hyperlegible-next",
    file: "400Regular/AtkinsonHyperlegibleNext_400Regular.ttf",
  },
  medium: {
    pkg: "atkinson-hyperlegible-next",
    file: "500Medium/AtkinsonHyperlegibleNext_500Medium.ttf",
  },
  semiBold: {
    pkg: "atkinson-hyperlegible-next",
    file: "600SemiBold/AtkinsonHyperlegibleNext_600SemiBold.ttf",
  },
  bold: {
    pkg: "atkinson-hyperlegible-next",
    file: "700Bold/AtkinsonHyperlegibleNext_700Bold.ttf",
  },
  extraBold: {
    pkg: "atkinson-hyperlegible-next",
    file: "800ExtraBold/AtkinsonHyperlegibleNext_800ExtraBold.ttf",
  },
};

function charset(): number[] {
  const codes: number[] = [];
  for (let c = 0x20; c <= 0x7e; c += 1) codes.push(c);
  for (let c = 0xa0; c <= 0x17f; c += 1) codes.push(c);
  codes.push(0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac);
  return codes;
}

function isKerned(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0x2018 && code <= 0x201d);
}

interface Point {
  x: number;
  y: number;
  on: boolean;
}

interface Font {
  data: Buffer;
  tables: Map<string, number>;
}

function openFont(data: Buffer): Font {
  const tables = new Map<string, number>();
  const count = data.readUInt16BE(4);
  for (let i = 0; i < count; i += 1) {
    const at = 12 + 16 * i;
    tables.set(data.toString("latin1", at, at + 4), data.readUInt32BE(at + 8));
  }
  return { data, tables };
}

function table(font: Font, tag: string): number {
  const at = font.tables.get(tag);
  if (at === undefined) throw new Error(`missing table ${tag}`);
  return at;
}

function readCmap(font: Font): Map<number, number> {
  const d = font.data;
  const base = table(font, "cmap");
  const map = new Map<number, number>();
  const count = d.readUInt16BE(base + 2);
  for (let i = 0; i < count; i += 1) {
    const platform = d.readUInt16BE(base + 4 + 8 * i);
    const encoding = d.readUInt16BE(base + 6 + 8 * i);
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const sub = base + d.readUInt32BE(base + 8 + 8 * i);
    const format = d.readUInt16BE(sub);
    if (format === 4) {
      const segs = d.readUInt16BE(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + 2 * segs + 2;
      const deltas = starts + 2 * segs;
      const ranges = deltas + 2 * segs;
      for (let s = 0; s < segs; s += 1) {
        const end = d.readUInt16BE(ends + 2 * s);
        const start = d.readUInt16BE(starts + 2 * s);
        const delta = d.readInt16BE(deltas + 2 * s);
        const range = d.readUInt16BE(ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          let glyph: number;
          if (range === 0) glyph = (c + delta) & 0xffff;
          else {
            const at = ranges + 2 * s + range + 2 * (c - start);
            glyph = d.readUInt16BE(at);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0 && !map.has(c)) map.set(c, glyph);
        }
      }
    } else if (format === 12) {
      const groups = d.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g += 1) {
        const at = sub + 16 + 12 * g;
        const start = d.readUInt32BE(at);
        const end = d.readUInt32BE(at + 4);
        const first = d.readUInt32BE(at + 8);
        for (let c = start; c <= end; c += 1) if (!map.has(c)) map.set(c, first + c - start);
      }
    }
  }
  return map;
}

function readLoca(font: Font): number[] {
  const d = font.data;
  const longFormat = d.readInt16BE(table(font, "head") + 50) === 1;
  const glyphs = d.readUInt16BE(table(font, "maxp") + 4);
  const loca = table(font, "loca");
  const offsets: number[] = [];
  for (let i = 0; i <= glyphs; i += 1) {
    offsets.push(longFormat ? d.readUInt32BE(loca + 4 * i) : d.readUInt16BE(loca + 2 * i) * 2);
  }
  return offsets;
}

function readGlyph(font: Font, loca: number[], glyph: number, depth = 0): Point[][] {
  const d = font.data;
  const start = loca[glyph]!;
  if (depth > MAX_COMPOSITE_DEPTH) throw new Error(`glyph ${glyph} nests composites too deeply`);
  if (loca[glyph + 1]! === start) return [];
  const at = table(font, "glyf") + start;
  const contourCount = d.readInt16BE(at);
  if (contourCount >= 0) return readSimpleGlyph(d, at, contourCount);
  const contours: Point[][] = [];
  let p = at + 10;
  for (;;) {
    const flags = d.readUInt16BE(p);
    const component = d.readUInt16BE(p + 2);
    p += 4;
    let dx: number;
    let dy: number;
    if (flags & 0x1) {
      dx = d.readInt16BE(p);
      dy = d.readInt16BE(p + 2);
      p += 4;
    } else {
      dx = d.readInt8(p);
      dy = d.readInt8(p + 1);
      p += 2;
    }
    if (!(flags & 0x2)) throw new Error("point-matched composite glyphs are not supported");
    let [a, b, c, e] = [1, 0, 0, 1];
    if (flags & 0x8) {
      a = e = d.readInt16BE(p) / 16384;
      p += 2;
    } else if (flags & 0x40) {
      a = d.readInt16BE(p) / 16384;
      e = d.readInt16BE(p + 2) / 16384;
      p += 4;
    } else if (flags & 0x80) {
      a = d.readInt16BE(p) / 16384;
      b = d.readInt16BE(p + 2) / 16384;
      c = d.readInt16BE(p + 4) / 16384;
      e = d.readInt16BE(p + 6) / 16384;
      p += 8;
    }
    for (const contour of readGlyph(font, loca, component, depth + 1)) {
      contours.push(
        contour.map((pt) => ({
          x: Math.round(a * pt.x + c * pt.y + dx),
          y: Math.round(b * pt.x + e * pt.y + dy),
          on: pt.on,
        })),
      );
    }
    if (!(flags & 0x20)) break;
  }
  return contours;
}

function readSimpleGlyph(d: Buffer, at: number, contourCount: number): Point[][] {
  const ends: number[] = [];
  for (let i = 0; i < contourCount; i += 1) ends.push(d.readUInt16BE(at + 10 + 2 * i));
  const pointCount = contourCount === 0 ? 0 : ends[contourCount - 1]! + 1;
  let p = at + 10 + 2 * contourCount;
  p += 2 + d.readUInt16BE(p);
  const flags: number[] = [];
  while (flags.length < pointCount) {
    const flag = d.readUInt8(p++);
    flags.push(flag);
    if (flag & 0x8) {
      const repeat = d.readUInt8(p++);
      for (let r = 0; r < repeat; r += 1) flags.push(flag);
    }
  }
  const axis = (shortBit: number, sameBit: number): number[] => {
    const values: number[] = [];
    let value = 0;
    for (const flag of flags) {
      if (flag & shortBit) {
        const delta = d.readUInt8(p++);
        value += flag & sameBit ? delta : -delta;
      } else if (!(flag & sameBit)) {
        value += d.readInt16BE(p);
        p += 2;
      }
      values.push(value);
    }
    return values;
  };
  const xs = axis(0x2, 0x10);
  const ys = axis(0x4, 0x20);
  const contours: Point[][] = [];
  let first = 0;
  for (const end of ends) {
    const contour: Point[] = [];
    for (let i = first; i <= end; i += 1) {
      contour.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 0x1) !== 0 });
    }
    contours.push(contour);
    first = end + 1;
  }
  return contours;
}

function advanceOf(font: Font, glyph: number): number {
  const d = font.data;
  const metrics = d.readUInt16BE(table(font, "hhea") + 34);
  const index = Math.min(glyph, metrics - 1);
  return d.readUInt16BE(table(font, "hmtx") + 4 * index);
}

const coverageCache = new Map<number, { data: Buffer; map: Map<number, number> }>();

function readCoverage(d: Buffer, at: number): Map<number, number> {
  const cached = coverageCache.get(at);
  if (cached !== undefined && cached.data === d) return cached.map;
  const map = new Map<number, number>();
  coverageCache.set(at, { data: d, map });
  const format = d.readUInt16BE(at);
  const count = d.readUInt16BE(at + 2);
  if (format === 1) {
    for (let i = 0; i < count; i += 1) map.set(d.readUInt16BE(at + 4 + 2 * i), i);
  } else {
    for (let r = 0; r < count; r += 1) {
      const start = d.readUInt16BE(at + 4 + 6 * r);
      const end = d.readUInt16BE(at + 6 + 6 * r);
      const index = d.readUInt16BE(at + 8 + 6 * r);
      for (let g = start; g <= end; g += 1) map.set(g, index + g - start);
    }
  }
  return map;
}

function classOf(d: Buffer, at: number, glyph: number): number {
  const format = d.readUInt16BE(at);
  if (format === 1) {
    const start = d.readUInt16BE(at + 2);
    const count = d.readUInt16BE(at + 4);
    return glyph >= start && glyph < start + count
      ? d.readUInt16BE(at + 6 + 2 * (glyph - start))
      : 0;
  }
  const ranges = d.readUInt16BE(at + 2);
  for (let r = 0; r < ranges; r += 1) {
    const p = at + 4 + 6 * r;
    if (glyph >= d.readUInt16BE(p) && glyph <= d.readUInt16BE(p + 2)) return d.readUInt16BE(p + 4);
  }
  return 0;
}

function bits(format: number): number {
  let n = 0;
  for (let f = format; f !== 0; f >>= 1) n += f & 1;
  return n;
}

function xAdvance(d: Buffer, at: number, format: number): number {
  if (!(format & 0x4)) return 0;
  return d.readInt16BE(at + 2 * bits(format & 0x3));
}

function kernSubtables(font: Font): number[][] {
  const d = font.data;
  const gpos = font.tables.get("GPOS");
  if (gpos === undefined) return [];
  const features = gpos + d.readUInt16BE(gpos + 6);
  const lookups = gpos + d.readUInt16BE(gpos + 8);
  const lookupIds = new Set<number>();
  for (let f = 0; f < d.readUInt16BE(features); f += 1) {
    if (d.toString("latin1", features + 2 + 6 * f, features + 6 + 6 * f) !== "kern") continue;
    const feature = features + d.readUInt16BE(features + 6 + 6 * f);
    for (let i = 0; i < d.readUInt16BE(feature + 2); i += 1) {
      lookupIds.add(d.readUInt16BE(feature + 4 + 2 * i));
    }
  }
  const result: number[][] = [];
  for (const id of [...lookupIds].sort((a, b) => a - b)) {
    const lookup = lookups + d.readUInt16BE(lookups + 2 + 2 * id);
    const type = d.readUInt16BE(lookup);
    const subtables: number[] = [];
    for (let s = 0; s < d.readUInt16BE(lookup + 4); s += 1) {
      let sub = lookup + d.readUInt16BE(lookup + 6 + 2 * s);
      if (type === 9) {
        if (d.readUInt16BE(sub + 2) !== 2) continue;
        sub += d.readUInt32BE(sub + 4);
      } else if (type !== 2) continue;
      subtables.push(sub);
    }
    result.push(subtables);
  }
  return result;
}

function pairValue(d: Buffer, sub: number, left: number, right: number): number | null {
  const format = d.readUInt16BE(sub);
  const coverage = readCoverage(d, sub + d.readUInt16BE(sub + 2));
  const index = coverage.get(left);
  if (index === undefined) return null;
  const format1 = d.readUInt16BE(sub + 4);
  const format2 = d.readUInt16BE(sub + 6);
  const size = 2 * (bits(format1) + bits(format2));
  if (format === 1) {
    const set = sub + d.readUInt16BE(sub + 10 + 2 * index);
    const count = d.readUInt16BE(set);
    for (let i = 0; i < count; i += 1) {
      const rec = set + 2 + i * (2 + size);
      if (d.readUInt16BE(rec) === right) return xAdvance(d, rec + 2, format1);
    }
    return null;
  }
  const class1 = classOf(d, sub + d.readUInt16BE(sub + 8), left);
  const class2 = classOf(d, sub + d.readUInt16BE(sub + 10), right);
  const class2Count = d.readUInt16BE(sub + 14);
  const rec = sub + 16 + (class1 * class2Count + class2) * size;
  return xAdvance(d, rec, format1);
}

function encodeFace(path: string): string {
  const font = openFont(readFileSync(path));
  const d = font.data;
  const cmap = readCmap(font);
  const loca = readLoca(font);
  const hhea = table(font, "hhea");
  const values: number[] = [
    d.readUInt16BE(table(font, "head") + 18),
    d.readInt16BE(hhea + 4),
    d.readInt16BE(hhea + 6),
  ];
  const kept: { code: number; glyph: number }[] = [];
  for (const code of charset()) {
    const glyph = cmap.get(code);
    if (glyph !== undefined) kept.push({ code, glyph });
  }
  values.push(kept.length);
  for (const { code, glyph } of kept) {
    const contours = readGlyph(font, loca, glyph);
    values.push(code, advanceOf(font, glyph), contours.length);
    for (const contour of contours) {
      values.push(contour.length);
      for (const pt of contour) values.push(pt.x * 2 + (pt.on ? 1 : 0), pt.y);
    }
  }
  const lookups = kernSubtables(font);
  const pairs: number[] = [];
  const kerned = kept.map(({ code }) => isKerned(code));
  for (let l = 0; l < kept.length; l += 1) {
    if (!kerned[l]) continue;
    for (let r = 0; r < kept.length; r += 1) {
      if (!kerned[r]) continue;
      let total = 0;
      for (const subtables of lookups) {
        for (const sub of subtables) {
          const value = pairValue(d, sub, kept[l]!.glyph, kept[r]!.glyph);
          if (value !== null) {
            total += value;
            break;
          }
        }
      }
      if (total !== 0) pairs.push(l, r, total);
    }
  }
  values.push(pairs.length / 3, ...pairs);
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => {
    if (v < -32768 || v > 32767) throw new Error(`value ${v} does not fit in int16`);
    bytes.writeInt16LE(v, i * 2);
  });
  return bytes.toString("base64");
}

function main(): void {
  const data = Object.entries(FACES).map(([name, { pkg, file }]) => {
    return `  ${name}:\n    "${encodeFace(join(FONT_ROOT, pkg, file))}",`;
  });
  const text = `export const FACE_DATA = {\n${data.join("\n")}\n} as const;\n`;
  writeFileSync(OUTPUT, text);
  console.log(`wrote ${OUTPUT} (${text.length} characters)`);
}

main();
