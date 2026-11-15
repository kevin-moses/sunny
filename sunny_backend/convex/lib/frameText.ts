// lib/frameText.ts
// Purpose: Text for the server-drawn display frames: decodes the generated glyph outlines
// (lib/fonts/frameFontData.ts, made by scripts/buildFrameFonts.ts) once per isolate, measures
// strings with pair kerning, breaks them into lines and draws a line as one filled path on a
// Canvas (lib/frameRaster.ts).
//
// Line breaking follows what the iPad's React Native text does with numberOfLines and tail
// truncation (sunny_app/src/display/DisplayParts.tsx): words wrap at spaces, a word wider than
// the line breaks between characters, and when the text needs more lines than allowed the last
// line ends in "…" after as many characters as fit. fitText is adjustsFontSizeToFit with
// minimumFontScale: the largest size, down to the minimum, at which the whole text fits in the
// allowed lines; at the minimum it is truncated.
//
// Kerning covers pairs of printable ASCII and curly quotes only (accented letters and "…" are
// set unkerned; scripts/buildFrameFonts.ts). One walk (walk) places glyphs and measures every
// prefix, so drawing and line breaking always agree.
//
// cleanText prepares household words so meaning is never lost to a missing glyph: symbols
// such as the micro sign ("µg" draws "mcg"), comparison signs, arrows and fractions are written
// out (SUBSTITUTIONS), letters the faces lack lose their accents ("Ō" draws "O"), and only what
// is left (emoji, pictographs, scripts outside Latin) is dropped, never drawn as an empty box,
// which a senior could read as a checkbox. It checks against the regular Atkinson face; every
// Atkinson weight has the same characters, and Literata (header and date only) has more.
//
// Last modified: 2026-11-14

import { FACE_DATA } from "./fonts/frameFontData";
import { Path } from "./frameRaster";
import type { Canvas, Paint } from "./frameRaster";
import { oneLine } from "./text";

/** The faces, named as sunny_app/src/display/theme.ts names them. */
export type FaceName = keyof typeof FACE_DATA;

/** The truncation mark. */
const ELLIPSIS = "\u2026";

/** One glyph: its advance and contours in font units (y up), points as x, y, onCurve. */
interface Glyph {
  index: number;
  advance: number;
  contours: number[][];
}

/** A decoded face. */
interface Face {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyphs: Map<number, Glyph>;
  /** Kerning in font units by left index * 65536 + right index. */
  kerning: Map<number, number>;
}

/** A text style: face, size and line height in pixels. */
export interface TextStyle {
  face: FaceName;
  size: number;
  lineHeight: number;
}

/** Faces decoded so far (module scope, so an isolate decodes each once). */
const faces = new Map<FaceName, Face>();

/**
 * purpose: Decode a face from its base64 int16 stream (layout in scripts/buildFrameFonts.ts).
 * @param name: (FaceName) The face.
 * @return: (Face) The face.
 */
function face(name: FaceName): Face {
  const cached = faces.get(name);
  if (cached !== undefined) return cached;
  // A plain loop: Uint8Array.from with a mapping function (lib/base64.ts fromBase64) takes about
  // 20 ms over the 530 KB of font data on a cold isolate, this under 1 ms.
  const binary = atob(FACE_DATA[name]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  let at = 0;
  /**
   * purpose: The next little-endian int16 of the stream.
   * @return: (number) The value.
   */
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

/**
 * Characters written out before drawing, so no meaning is lost by leaving a character out:
 * symbols in doses and instructions (the micro sign as "mc", so "µg" draws "mcg", the spelling
 * pharmacists use because "µg" is misread as "mg"; comparison signs; arrows; times and divide;
 * fractions, spaced so "1½" draws "1 1/2"; prime marks, the minus sign, degrees Celsius and
 * Fahrenheit), the invisible soft hyphen and the trademark sign, and the letters the Atkinson
 * faces lack that have no decomposition (scripts/buildFrameFonts.ts lists every character each
 * face lacks). The degree sign itself, the plus-minus sign and the dashes are in every face and
 * stay.
 */
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

/**
 * purpose: Prepare words from the household (labels, names, steps) for a frame. After Unicode
 *          NFC: a character in SUBSTITUTIONS is written out; whitespace becomes a space; a
 *          character the regular Atkinson face has stays; any other is decomposed with its
 *          compatibility forms (NFKD), its parts written out through SUBSTITUTIONS, and the drawable
 *          parts kept without their marks, so "Ō" draws "O", "ﬁ" draws "fi", "５㎎" draws "5mg"
 *          and "H₂O" draws "H2O"; what is left (emoji,
 *          pictographs, scripts outside Latin) is left out rather than drawn as an empty box,
 *          which a senior could read as a checkbox. Runs of spaces become one; trimmed. The
 *          result can be empty; callers then draw a plain fallback.
 * @param text: (string) The text.
 * @return: (string) The cleaned text.
 */
export function cleanText(text: string): string {
  const { glyphs } = face("regular");
  /**
   * purpose: Whether the regular face draws a character.
   * @param ch: (string) One character.
   * @return: (boolean) True when it has the glyph.
   */
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

/** One pass over a string in a face: where each glyph goes and the pen after every prefix. */
interface Walk {
  chars: string[];
  /** glyphs[i]: the glyph of chars[i], or null when the face lacks it (it is skipped). */
  glyphs: (Glyph | null)[];
  /** starts[i]: the pen (font units, kerning included) where chars[i]'s glyph is drawn. */
  starts: number[];
  /** pens[n]: the pen after the first n characters (pens[length] is the whole width). */
  pens: number[];
  /** last[n]: the last glyph placed among the first n characters (for kerning onward). */
  last: (Glyph | null)[];
  /** Pixels per font unit. */
  scale: number;
  face: Face;
}

/**
 * purpose: Walk a string in a face once, with pair kerning: the glyph positions drawLine uses
 *          and the prefix widths line breaking uses, so they always agree (pens[n] * scale is
 *          the width of the first n characters).
 * @param text: (string | string[]) The text, or its characters.
 * @param style: (TextStyle) The style.
 * @return: (Walk) The walk.
 */
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

/**
 * purpose: The width of a text in pixels.
 * @param text: (string) Text, cleaned (cleanText).
 * @param style: (TextStyle) The style.
 * @return: (number) Width in pixels.
 */
export function measure(text: string, style: TextStyle): number {
  const { pens, scale } = walk(text, style);
  return pens[pens.length - 1]! * scale;
}

/**
 * purpose: The longest prefix of a string (whole characters) that fits a width, at least one
 *          character so a line always makes progress.
 * @param chars: (string[]) The characters.
 * @param style: (TextStyle) The style.
 * @param maxWidth: (number) Width in pixels.
 * @return: (number) How many characters fit.
 */
function fittingChars(chars: string[], style: TextStyle, maxWidth: number): number {
  const { pens, scale } = walk(chars, style);
  let n = chars.length;
  while (n > 1 && pens[n]! * scale > maxWidth) n -= 1;
  return n;
}

/**
 * purpose: Cut a line so that it plus "…" fits the width (the tail truncation of a last line):
 *          the longest prefix, trailing whitespace trimmed, whose width with "…" fits.
 * @param text: (string) The line's text (the rest of the text from the line's start).
 * @param style: (TextStyle) The style.
 * @param maxWidth: (number) Width in pixels.
 * @return: (string) The truncated line, ending in "…".
 */
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

/** Text broken into lines. */
export interface Lines {
  lines: string[];
  /** The text did not fit in the allowed lines and the last one ends in "…". */
  truncated: boolean;
}

/**
 * purpose: Break a text into at most maxLines lines of maxWidth pixels.
 * @param text: (string) Text, cleaned (cleanText).
 * @param style: (TextStyle) The style.
 * @param maxWidth: (number) Line width in pixels.
 * @param maxLines: (number) Most lines (at least 1).
 * @return: (Lines) The lines.
 */
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

/**
 * purpose: The largest style, from `style` down to minScale times its size (in steps of 5%),
 *          whose lines hold the whole text; at the smallest size the text is truncated.
 * @param text: (string) Text, cleaned (cleanText).
 * @param style: (TextStyle) The full-size style.
 * @param minScale: (number) Smallest size as a fraction (1 for no shrinking).
 * @param maxWidth: (number) Line width in pixels.
 * @param maxLines: (number) Most lines.
 * @return: ({ style: TextStyle } & Lines) The style used and the lines.
 */
export function fitText(
  text: string,
  style: TextStyle,
  minScale: number,
  maxWidth: number,
  maxLines: number,
): { style: TextStyle } & Lines {
  // At most 20 steps: 5% each reaches zero, so the loop ends whatever minScale is.
  for (let step = 0; ; step += 1) {
    const scale = Math.max(minScale, 1 - step * 0.05);
    const sized = { ...style, size: style.size * scale, lineHeight: style.lineHeight * scale };
    const broken = breakLines(text, sized, maxWidth, maxLines);
    if (!broken.truncated || scale <= minScale || step >= 20) return { style: sized, ...broken };
  }
}

/**
 * purpose: The baseline of a line inside a line box: the face's ascent and descent centered in
 *          the line height, as iOS lays out a line with a fixed line height.
 * @param style: (TextStyle) The style.
 * @param top: (number) The line box's top in pixels.
 * @return: (number) The baseline y in pixels.
 */
function baselineIn(style: TextStyle, top: number): number {
  const f = face(style.face);
  const scale = style.size / f.unitsPerEm;
  const ascent = f.ascender * scale;
  const descent = -f.descender * scale;
  return top + (style.lineHeight - ascent - descent) / 2 + ascent;
}

/**
 * purpose: Draw one line of text with its line box's top-left at (x, top); x and the
 *          baseline are snapped to whole pixels so stems land the same way every time.
 * @param canvas: (Canvas) The canvas.
 * @param text: (string) Text, cleaned (cleanText).
 * @param style: (TextStyle) The style.
 * @param x: (number) Left in pixels.
 * @param top: (number) Line box top in pixels.
 * @param paint: (Paint) The paint.
 * @return: (number) The drawn width in pixels.
 */
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

/**
 * purpose: Add one TrueType contour (quadratic, implied on-curve midpoints between two
 *          off-curve points) to a path, flipped to screen y.
 * @param path: (Path) The path.
 * @param points: (number[]) x, y, onCurve triples in font units.
 * @param ox: (number) Pen x in pixels.
 * @param baseline: (number) Baseline y in pixels.
 * @param scale: (number) Pixels per font unit.
 * @return: (void)
 */
function addContour(
  path: Path,
  points: number[],
  ox: number,
  baseline: number,
  scale: number,
): void {
  const n = points.length / 3;
  if (n < 2) return;
  /**
   * purpose: A point's x in pixels (indexes wrap around the contour).
   * @param i: (number) Point index.
   * @return: (number) Pixels.
   */
  const px = (i: number): number => ox + points[3 * (i % n)]! * scale;
  /**
   * purpose: A point's y in pixels, flipped from the font's y up (indexes wrap around).
   * @param i: (number) Point index.
   * @return: (number) Pixels.
   */
  const py = (i: number): number => baseline - points[3 * (i % n) + 1]! * scale;
  /**
   * purpose: Whether a point is on the curve (indexes wrap around).
   * @param i: (number) Point index.
   * @return: (boolean) True for an on-curve point.
   */
  const on = (i: number): boolean => points[3 * (i % n) + 2] === 1;
  // Start on an on-curve point, or the midpoint of the first two off-curve points.
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
