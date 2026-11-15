import { fromBase64 } from "./base64";
import { FACE_DATA } from "./fonts/frameFontData";
import { Path } from "./frameRaster";
import type { Canvas, Paint } from "./frameRaster";
import { oneLine } from "./text";

export type FaceName = keyof typeof FACE_DATA;

const ELLIPSIS = "\u2026";

interface Glyph {
  index: number;
  advance: number;
  contours: number[][];
}

interface Face {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyphs: Map<number, Glyph>;
  kerning: Map<number, number>;
}

export interface TextStyle {
  face: FaceName;
  size: number;
  lineHeight: number;
}

const faces = new Map<FaceName, Face>();

function face(name: FaceName): Face {
  const cached = faces.get(name);
  if (cached !== undefined) return cached;
  const view = new DataView(fromBase64(FACE_DATA[name]).buffer);
  let at = 0;
  const next = (): number => {
    const value = view.getInt16(at, true);
    at += 2;
    return value;
  };
  const [unitsPerEm, ascender, descender] = [next(), next(), next()];
  const glyphs = new Map<number, Glyph>();
  const glyphCount = next();
  for (let index = 0; index < glyphCount; index += 1) {
    const code = next() & 0xffff;
    const advance = next();
    const contours: number[][] = [];
    const contourCount = next();
    for (let c = 0; c < contourCount; c += 1) {
      const points: number[] = [];
      const pointCount = next();
      for (let p = 0; p < pointCount; p += 1) {
        const packed = next();
        const on = packed & 1;
        points.push((packed - on) / 2, next(), on);
      }
      contours.push(points);
    }
    glyphs.set(code, { index, advance, contours });
  }
  const kerning = new Map<number, number>();
  const pairCount = next();
  for (let i = 0; i < pairCount; i += 1) {
    const left = next();
    const right = next();
    kerning.set(left * 65536 + right, next());
  }
  const decoded: Face = { unitsPerEm, ascender, descender, glyphs, kerning };
  faces.set(name, decoded);
  return decoded;
}

const SUBSTITUTIONS = new Map<string, string>([
  ["\u00b5", "mc"],
  ["\u03bc", "mc"],
  ["\u2265", ">="],
  ["\u2264", "<="],
  ["\u2192", " to "],
  ["\u21d2", " to "],
  ["\u27f6", " to "],
  ["\u2794", " to "],
  ["\u2190", " <- "],
  ["\u2194", " <-> "],
  ["\u00d7", "x"],
  ["\u00f7", "/"],
  ["\u00bd", " 1/2"],
  ["\u00bc", " 1/4"],
  ["\u00be", " 3/4"],
  ["\u2153", " 1/3"],
  ["\u2154", " 2/3"],
  ["\u215b", " 1/8"],
  ["\u2032", "'"],
  ["\u2033", '"'],
  ["\u2212", "-"],
  ["\u2011", "-"],
  ["\u2103", "\u00b0C"],
  ["\u2109", "\u00b0F"],
  ["\u2122", ""],
  ["\u00ad", ""],
  ["\u017f", "s"],
  ["\u0138", "k"],
  ["\u0149", "'n"],
  ["\u013f", "L"],
  ["\u0140", "l"],
  ["\u014a", "N"],
  ["\u014b", "n"],
  ["\u0166", "T"],
  ["\u0167", "t"],
]);

export function cleanText(text: string): string {
  const { glyphs } = face("regular");
  const drawable = (ch: string): boolean => glyphs.has(ch.codePointAt(0)!);
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const written = SUBSTITUTIONS.get(ch);
    if (written !== undefined) out += written;
    else if (/\s/.test(ch)) out += " ";
    else if (drawable(ch)) out += ch;
    else {
      out += Array.from(ch.normalize("NFKD"))
        .map((part) => SUBSTITUTIONS.get(part) ?? part)
        .filter((part) => !/\p{M}/u.test(part) && Array.from(part).every(drawable))
        .join("");
    }
  }
  return oneLine(out);
}

interface Walk {
  chars: string[];
  glyphs: (Glyph | null)[];
  starts: number[];
  pens: number[];
  last: (Glyph | null)[];
  scale: number;
  face: Face;
}

function walk(text: string | string[], style: TextStyle): Walk {
  const f = face(style.face);
  const chars = typeof text === "string" ? Array.from(text) : text;
  const glyphs: (Glyph | null)[] = [];
  const starts: number[] = [];
  const pens = [0];
  const last: (Glyph | null)[] = [null];
  let pen = 0;
  let previous: Glyph | null = null;
  for (const ch of chars) {
    const glyph = f.glyphs.get(ch.codePointAt(0)!) ?? null;
    if (glyph !== null) {
      if (previous !== null) pen += f.kerning.get(previous.index * 65536 + glyph.index) ?? 0;
      starts.push(pen);
      pen += glyph.advance;
      previous = glyph;
    } else {
      starts.push(pen);
    }
    glyphs.push(glyph);
    pens.push(pen);
    last.push(previous);
  }
  return { chars, glyphs, starts, pens, last, scale: style.size / f.unitsPerEm, face: f };
}

export function measure(text: string, style: TextStyle): number {
  const { pens, scale } = walk(text, style);
  return pens[pens.length - 1]! * scale;
}

function fittingChars(chars: string[], style: TextStyle, maxWidth: number): number {
  const { pens, scale } = walk(chars, style);
  let n = chars.length;
  while (n > 1 && pens[n]! * scale > maxWidth) n -= 1;
  return n;
}

function truncate(text: string, style: TextStyle, maxWidth: number): string {
  const { chars, pens, last, scale, face: f } = walk(text, style);
  const ellipsis = f.glyphs.get(ELLIPSIS.codePointAt(0)!);
  for (let n = chars.length; n > 0; n -= 1) {
    let m = n;
    while (m > 0 && /\s/.test(chars[m - 1]!)) m -= 1;
    let pen = pens[m]!;
    const previous = last[m]!;
    if (ellipsis !== undefined) {
      if (previous !== null) pen += f.kerning.get(previous.index * 65536 + ellipsis.index) ?? 0;
      pen += ellipsis.advance;
    }
    if (pen * scale <= maxWidth) return `${chars.slice(0, m).join("")}${ELLIPSIS}`;
  }
  return ELLIPSIS;
}

export interface Lines {
  lines: string[];
  truncated: boolean;
}

export function breakLines(
  text: string,
  style: TextStyle,
  maxWidth: number,
  maxLines: number,
): Lines {
  const lines: string[] = [];
  let rest = text;
  while (rest !== "") {
    if (lines.length === maxLines - 1 && measure(rest, style) > maxWidth) {
      lines.push(truncate(rest, style, maxWidth));
      return { lines, truncated: true };
    }
    const words = rest.split(" ");
    let line = words[0]!;
    let used = 1;
    if (measure(line, style) > maxWidth) {
      const chars = Array.from(line);
      line = chars.slice(0, fittingChars(chars, style, maxWidth)).join("");
      rest = rest.slice(line.length).replace(/^ +/, "");
    } else {
      while (used < words.length && measure(`${line} ${words[used]}`, style) <= maxWidth) {
        line = `${line} ${words[used]}`;
        used += 1;
      }
      rest = words.slice(used).join(" ");
    }
    lines.push(line);
  }
  return { lines, truncated: false };
}

export function fitText(
  text: string,
  style: TextStyle,
  minScale: number,
  maxWidth: number,
  maxLines: number,
): { style: TextStyle } & Lines {
  for (let step = 0; ; step += 1) {
    const scale = Math.max(minScale, 1 - step * 0.05);
    const sized = { ...style, size: style.size * scale, lineHeight: style.lineHeight * scale };
    const broken = breakLines(text, sized, maxWidth, maxLines);
    if (!broken.truncated || scale <= minScale || step >= 20) return { style: sized, ...broken };
  }
}

function baselineIn(style: TextStyle, top: number): number {
  const f = face(style.face);
  const scale = style.size / f.unitsPerEm;
  const ascent = f.ascender * scale;
  const descent = -f.descender * scale;
  return top + (style.lineHeight - ascent - descent) / 2 + ascent;
}

export function drawLine(
  canvas: Canvas,
  text: string,
  style: TextStyle,
  x: number,
  top: number,
  paint: Paint,
): number {
  const originX = Math.round(x);
  const baseline = Math.round(baselineIn(style, top));
  const { glyphs, starts, pens, scale } = walk(text, style);
  const path = new Path();
  glyphs.forEach((glyph, i) => {
    if (glyph === null) return;
    const gx = originX + starts[i]! * scale;
    for (const points of glyph.contours) addContour(path, points, gx, baseline, scale);
  });
  if (path.segments.length > 0) canvas.fillPath(path, paint);
  return pens[pens.length - 1]! * scale;
}

function addContour(
  path: Path,
  points: number[],
  ox: number,
  baseline: number,
  scale: number,
): void {
  const n = points.length / 3;
  if (n < 2) return;
  const px = (i: number): number => ox + points[3 * (i % n)]! * scale;
  const py = (i: number): number => baseline - points[3 * (i % n) + 1]! * scale;
  const on = (i: number): boolean => points[3 * (i % n) + 2] === 1;
  let first = 0;
  while (first < n && !on(first)) first += 1;
  let startX: number;
  let startY: number;
  if (first === n) {
    startX = (px(0) + px(1)) / 2;
    startY = (py(0) + py(1)) / 2;
    first = 0;
  } else {
    startX = px(first);
    startY = py(first);
  }
  path.moveTo(startX, startY);
  let controlX: number | null = null;
  let controlY = 0;
  for (let k = 1; k <= n; k += 1) {
    const i = first + k;
    const x = k === n && on(first) ? startX : px(i);
    const y = k === n && on(first) ? startY : py(i);
    if (on(i)) {
      if (controlX === null) path.lineTo(x, y);
      else path.quadTo(controlX, controlY, x, y);
      controlX = null;
    } else if (controlX === null) {
      controlX = x;
      controlY = y;
    } else {
      const midX = (controlX + x) / 2;
      const midY = (controlY + y) / 2;
      path.quadTo(controlX, controlY, midX, midY);
      controlX = x;
      controlY = y;
    }
  }
  if (controlX !== null) path.quadTo(controlX, controlY, startX, startY);
  path.close();
}
