// lib/frameRaster.ts
// Purpose: The drawing surface of the server-drawn display frames (lib/frame.ts). A Canvas holds
// one 8-bit luminance value per pixel (255 paper, 0 ink) and draws filled rectangles and filled
// paths (lines and quadratic curves: glyph outlines and icons) with exact area coverage
// antialiasing, the accumulation method of font-rs. toFrame then maps luminance to the panel's
// grey levels: the nearest level, so with 4 greys a text edge gets one in-between grey and with
// 2 greys everything is a crisp 1-bit threshold at half coverage.
//
// Paints: ink, paper and grey (finished and missed items). With 3 or more greys, grey is the
// level nearest the design's #6B6B6B; with 2 greys it is a 50% checkerboard of ink and paper
// fixed to the pixel grid, so a greyed row still looks different from a plain one on a 1-bit
// panel.
//
// Everything here is deterministic: only +, -, *, /, Math.floor, Math.ceil, Math.round,
// Math.min, Math.max, Math.abs and Math.sqrt (all exactly specified by IEEE 754 and
// ECMAScript), so the same drawing calls always give the same bytes.
//
// Last modified: 2026-11-14

import type { DeviceScreen } from "./validators";

/**
 * A screen as a device reports it (PUT /device/info, stored on its devices row): width and
 * height in pixels, and greys, the levels the panel shows, black and white included (2 for a
 * 1-bit panel).
 */
export type Screen = DeviceScreen;

/** A finished frame: one grey level per pixel, row-major, 0 = black, greys - 1 = white. */
export interface Frame {
  width: number;
  height: number;
  greys: number;
  levels: Uint8Array;
}

/** What a shape is filled with. */
export type Paint = "ink" | "grey" | "paper";

/** The luminance of the design's grey (#6B6B6B). */
const GREY_LUMINANCE = 0x6b;

/** Curve flattening tolerance, in pixels. */
const FLATTEN_TOLERANCE = 0.05;

/** Most line segments one quadratic curve becomes. */
const MAX_CURVE_SEGMENTS = 32;

/**
 * A path in pixel coordinates: closed contours of straight segments. Curves are flattened as
 * they are added.
 */
export class Path {
  /** Segments as x0, y0, x1, y1 quadruples. */
  readonly segments: number[] = [];
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  private startX = 0;
  private startY = 0;
  private x = 0;
  private y = 0;

  /**
   * purpose: Start a new contour (closing the previous one).
   * @param x: (number) X in pixels.
   * @param y: (number) Y in pixels.
   * @return: (Path) This path.
   */
  moveTo(x: number, y: number): Path {
    this.close();
    this.startX = this.x = x;
    this.startY = this.y = y;
    this.extend(x, y);
    return this;
  }

  /**
   * purpose: A straight segment to a point.
   * @param x: (number) X in pixels.
   * @param y: (number) Y in pixels.
   * @return: (Path) This path.
   */
  lineTo(x: number, y: number): Path {
    if (x !== this.x || y !== this.y) {
      this.segments.push(this.x, this.y, x, y);
      this.extend(x, y);
    }
    this.x = x;
    this.y = y;
    return this;
  }

  /**
   * purpose: A quadratic curve to a point, flattened into enough segments that it is never
   *          more than FLATTEN_TOLERANCE pixels off.
   * @param cx: (number) Control point x.
   * @param cy: (number) Control point y.
   * @param x: (number) End x.
   * @param y: (number) End y.
   * @return: (Path) This path.
   */
  quadTo(cx: number, cy: number, x: number, y: number): Path {
    const x0 = this.x;
    const y0 = this.y;
    const ddx = x0 - 2 * cx + x;
    const ddy = y0 - 2 * cy + y;
    const deviation = Math.sqrt(ddx * ddx + ddy * ddy);
    const n = Math.min(
      MAX_CURVE_SEGMENTS,
      Math.max(1, Math.ceil(Math.sqrt(deviation / (8 * FLATTEN_TOLERANCE)))),
    );
    for (let i = 1; i <= n; i += 1) {
      const t = i / n;
      const u = 1 - t;
      this.lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
    }
    return this;
  }

  /**
   * purpose: Close the current contour back to its start.
   * @return: (Path) This path.
   */
  close(): Path {
    this.lineTo(this.startX, this.startY);
    return this;
  }

  /**
   * purpose: Grow the bounds to include a point.
   * @param x: (number) X.
   * @param y: (number) Y.
   * @return: (void)
   */
  private extend(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }
}

/**
 * purpose: Add one line's signed area to an accumulation buffer (font-rs draw_line). The
 *          running sum of a row then gives each pixel's coverage.
 * @param acc: (Float64Array) The buffer, `stride` wide per row.
 * @param stride: (number) Row length (the box width plus 2).
 * @param height: (number) Rows.
 * @param ax: (number) Start x, already clamped to the box.
 * @param ay: (number) Start y.
 * @param bx: (number) End x, already clamped to the box.
 * @param by: (number) End y.
 * @return: (void)
 */
function accumulateLine(
  acc: Float64Array,
  stride: number,
  height: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): void {
  if (ay === by) return;
  const dir = ay < by ? 1 : -1;
  const [x0, y0, x1, y1] = ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay];
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = y0 < 0 ? x0 - y0 * dxdy : x0;
  const yEnd = Math.min(height, Math.ceil(y1));
  for (let y = Math.max(0, Math.floor(y0)); y < yEnd; y += 1) {
    const row = y * stride;
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xNext = x + dxdy * dy;
    const d = dy * dir;
    const left = Math.min(x, xNext);
    const right = Math.max(x, xNext);
    const leftFloor = Math.floor(left);
    const rightCeil = Math.ceil(right);
    if (rightCeil <= leftFloor + 1) {
      const mid = 0.5 * (x + xNext) - leftFloor;
      acc[row + leftFloor]! += d - d * mid;
      acc[row + leftFloor + 1]! += d * mid;
    } else {
      const s = 1 / (right - left);
      const leftFrac = left - leftFloor;
      const a0 = 0.5 * s * (1 - leftFrac) * (1 - leftFrac);
      const rightFrac = right - rightCeil + 1;
      const am = 0.5 * s * rightFrac * rightFrac;
      acc[row + leftFloor]! += d * a0;
      if (rightCeil === leftFloor + 2) {
        acc[row + leftFloor + 1]! += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - leftFrac);
        acc[row + leftFloor + 1]! += d * (a1 - a0);
        for (let xi = leftFloor + 2; xi < rightCeil - 1; xi += 1) acc[row + xi]! += d * s;
        const a2 = a1 + (rightCeil - leftFloor - 3) * s;
        acc[row + rightCeil - 1]! += d * (1 - a2 - am);
      }
      acc[row + rightCeil]! += d * am;
    }
    x = xNext;
  }
}

/** A grey-level drawing surface of one screen's size. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly greys: number;
  /** Luminance per pixel, 255 paper. */
  private readonly luminance: Uint8Array;
  private readonly greyLuminance: number;

  /**
   * purpose: A blank (paper) canvas.
   * @param screen: (Screen) Size and grey levels.
   */
  constructor(screen: Screen) {
    this.width = screen.width;
    this.height = screen.height;
    this.greys = screen.greys;
    this.luminance = new Uint8Array(screen.width * screen.height).fill(255);
    const step = 255 / (screen.greys - 1);
    this.greyLuminance = Math.round(Math.round(GREY_LUMINANCE / step) * step);
  }

  /**
   * purpose: The luminance a paint puts at a pixel (grey on a 2-level panel is a checkerboard).
   * @param paint: (Paint) The paint.
   * @param x: (number) Pixel column.
   * @param y: (number) Pixel row.
   * @return: (number) 0 to 255.
   */
  private paintAt(paint: Paint, x: number, y: number): number {
    if (paint === "ink") return 0;
    if (paint === "paper") return 255;
    if (this.greys > 2) return this.greyLuminance;
    return (x + y) % 2 === 0 ? 0 : 255;
  }

  /**
   * purpose: Blend a paint into one pixel at a coverage.
   * @param x: (number) Column, inside the canvas.
   * @param y: (number) Row, inside the canvas.
   * @param coverage: (number) 0 to 1.
   * @param paint: (Paint) The paint.
   * @return: (void)
   */
  private blend(x: number, y: number, coverage: number, paint: Paint): void {
    const i = y * this.width + x;
    const dst = this.luminance[i]!;
    const src = this.paintAt(paint, x, y);
    this.luminance[i] = coverage >= 1 ? src : Math.round(dst + (src - dst) * coverage);
  }

  /**
   * purpose: Fill a rectangle snapped to whole pixels (edges rounded), clipped to the canvas.
   * @param x: (number) Left.
   * @param y: (number) Top.
   * @param width: (number) Width.
   * @param height: (number) Height.
   * @param paint: (Paint) The paint.
   * @return: (void)
   */
  fillRect(x: number, y: number, width: number, height: number, paint: Paint): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + width));
    const y1 = Math.min(this.height, Math.round(y + height));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.blend(px, py, 1, paint);
    }
  }

  /**
   * purpose: Draw a rectangle's border inside its bounds, every side `thickness` thick.
   * @param x: (number) Left.
   * @param y: (number) Top.
   * @param width: (number) Width.
   * @param height: (number) Height.
   * @param thickness: (number) Border width in pixels (whole).
   * @param paint: (Paint) The paint.
   * @return: (void)
   */
  strokeRect(
    x: number,
    y: number,
    width: number,
    height: number,
    thickness: number,
    paint: Paint,
  ): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + width);
    const y1 = Math.round(y + height);
    this.fillRect(x0, y0, x1 - x0, thickness, paint);
    this.fillRect(x0, y1 - thickness, x1 - x0, thickness, paint);
    this.fillRect(x0, y0 + thickness, thickness, y1 - y0 - 2 * thickness, paint);
    this.fillRect(x1 - thickness, y0 + thickness, thickness, y1 - y0 - 2 * thickness, paint);
  }

  /**
   * purpose: Fill a path (nonzero for shapes drawn in one direction; glyph holes, wound the
   *          other way, stay empty) with antialiased coverage. Rows above and below the canvas
   *          are cut exactly; points left or right of it are moved onto its edge rather than
   *          clipped, so a shape crossing a side edge is drawn slanted there (frames keep every
   *          shape inside the canvas).
   * @param path: (Path) The path.
   * @param paint: (Paint) The paint.
   * @return: (void)
   */
  fillPath(path: Path, paint: Paint): void {
    path.close();
    const left = Math.max(0, Math.floor(path.minX));
    const top = Math.max(0, Math.floor(path.minY));
    const right = Math.min(this.width, Math.ceil(path.maxX) + 1);
    const bottom = Math.min(this.height, Math.ceil(path.maxY) + 1);
    if (right <= left || bottom <= top) return;
    const width = right - left;
    const height = bottom - top;
    const stride = width + 2;
    const acc = new Float64Array(stride * height);
    const s = path.segments;
    for (let i = 0; i < s.length; i += 4) {
      const ax = Math.min(width, Math.max(0, s[i]! - left));
      const bx = Math.min(width, Math.max(0, s[i + 2]! - left));
      accumulateLine(acc, stride, height, ax, s[i + 1]! - top, bx, s[i + 3]! - top);
    }
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let x = 0; x < width; x += 1) {
        sum += acc[y * stride + x]!;
        const coverage = Math.min(1, Math.abs(sum));
        if (coverage > 1 / 512) this.blend(left + x, top + y, coverage, paint);
      }
    }
  }

  /**
   * purpose: The finished frame: each pixel's luminance mapped to the nearest grey level.
   * @return: (Frame) The frame.
   */
  toFrame(): Frame {
    const max = this.greys - 1;
    const levelOf = Uint8Array.from({ length: 256 }, (_, l) => Math.round((l * max) / 255));
    const levels = new Uint8Array(this.luminance.length);
    for (let i = 0; i < levels.length; i += 1) levels[i] = levelOf[this.luminance[i]!]!;
    return { width: this.width, height: this.height, greys: this.greys, levels };
  }
}

/** sqrt(1/2) and tan(pi/8), the constants of a circle made of eight quadratic arcs. */
const HALF_SQRT2 = 0.7071067811865476;
const TAN_EIGHTH = 0.41421356237309503;

/**
 * purpose: Add a circle (clockwise on screen) to a path, as eight quadratic arcs.
 * @param path: (Path) The path.
 * @param cx: (number) Center x.
 * @param cy: (number) Center y.
 * @param r: (number) Radius.
 * @return: (Path) The path.
 */
export function addCircle(path: Path, cx: number, cy: number, r: number): Path {
  const k = r * TAN_EIGHTH;
  const h = r * HALF_SQRT2;
  path.moveTo(cx + r, cy);
  path.quadTo(cx + r, cy + k, cx + h, cy + h);
  path.quadTo(cx + k, cy + r, cx, cy + r);
  path.quadTo(cx - k, cy + r, cx - h, cy + h);
  path.quadTo(cx - r, cy + k, cx - r, cy);
  path.quadTo(cx - r, cy - k, cx - h, cy - h);
  path.quadTo(cx - k, cy - r, cx, cy - r);
  path.quadTo(cx + k, cy - r, cx + h, cy - h);
  path.quadTo(cx + r, cy - k, cx + r, cy);
  return path.close();
}

/**
 * purpose: Add a rounded rectangle (clockwise on screen) to a path; each corner is two
 *          quadratic arcs.
 * @param path: (Path) The path.
 * @param x: (number) Left.
 * @param y: (number) Top.
 * @param width: (number) Width.
 * @param height: (number) Height.
 * @param radius: (number) Corner radius (clamped to half the shorter side).
 * @return: (Path) The path.
 */
export function addRoundRect(
  path: Path,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): Path {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const k = r * TAN_EIGHTH;
  const h = r * (1 - HALF_SQRT2);
  const right = x + width;
  const bottom = y + height;
  path.moveTo(x + r, y);
  path.lineTo(right - r, y);
  path.quadTo(right - r + k, y, right - h, y + h);
  path.quadTo(right, y + r - k, right, y + r);
  path.lineTo(right, bottom - r);
  path.quadTo(right, bottom - r + k, right - h, bottom - h);
  path.quadTo(right - r + k, bottom, right - r, bottom);
  path.lineTo(x + r, bottom);
  path.quadTo(x + r - k, bottom, x + h, bottom - h);
  path.quadTo(x, bottom - r + k, x, bottom - r);
  path.lineTo(x, y + r);
  path.quadTo(x, y + r - k, x + h, y + h);
  path.quadTo(x + r - k, y, x + r, y);
  return path.close();
}

/**
 * purpose: Add a thick polyline (round joins and caps) to a path: a quadrilateral per segment
 *          and a circle per point, all wound the same way so overlaps stay filled once.
 * @param path: (Path) The path.
 * @param points: (number[]) x, y pairs in pixels.
 * @param width: (number) Line width in pixels.
 * @return: (Path) The path.
 */
export function addPolyline(path: Path, points: number[], width: number): Path {
  const r = width / 2;
  for (let i = 0; i + 3 < points.length; i += 2) {
    addSegment(path, points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, r);
  }
  for (let i = 0; i + 1 < points.length; i += 2) addCircle(path, points[i]!, points[i + 1]!, r);
  return path;
}

/**
 * purpose: Add a thick straight segment with square ends (a quadrilateral, wound like
 *          addCircle) to a path; nothing for a segment of zero length.
 * @param path: (Path) The path.
 * @param x0: (number) Start x.
 * @param y0: (number) Start y.
 * @param x1: (number) End x.
 * @param y1: (number) End y.
 * @param r: (number) Half the width, in pixels.
 * @return: (Path) The path.
 */
export function addSegment(
  path: Path,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
): Path {
  const length = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  if (length === 0) return path;
  const nx = ((y1 - y0) / length) * r;
  const ny = (-(x1 - x0) / length) * r;
  path.moveTo(x0 + nx, y0 + ny);
  path.lineTo(x1 + nx, y1 + ny);
  path.lineTo(x1 - nx, y1 - ny);
  path.lineTo(x0 - nx, y0 - ny);
  return path.close();
}
