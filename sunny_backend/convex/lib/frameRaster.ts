import type { DeviceScreen } from "./validators";

export type Screen = DeviceScreen;

export interface Frame {
  width: number;
  height: number;
  greys: number;
  levels: Uint8Array;
}

export type Paint = "ink" | "grey" | "paper";

const GREY_LUMINANCE = 0x6b;

const FLATTEN_TOLERANCE = 0.05;

const MAX_CURVE_SEGMENTS = 32;

export class Path {
  readonly segments: number[] = [];
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  private startX = 0;
  private startY = 0;
  private x = 0;
  private y = 0;

  moveTo(x: number, y: number): Path {
    this.close();
    this.startX = this.x = x;
    this.startY = this.y = y;
    this.extend(x, y);
    return this;
  }

  lineTo(x: number, y: number): Path {
    if (x !== this.x || y !== this.y) {
      this.segments.push(this.x, this.y, x, y);
      this.extend(x, y);
    }
    this.x = x;
    this.y = y;
    return this;
  }

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

  close(): Path {
    this.lineTo(this.startX, this.startY);
    return this;
  }

  private extend(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }
}

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

export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly greys: number;
  private readonly luminance: Uint8Array;
  private readonly greyLuminance: number;

  constructor(screen: Screen) {
    this.width = screen.width;
    this.height = screen.height;
    this.greys = screen.greys;
    this.luminance = new Uint8Array(screen.width * screen.height).fill(255);
    const step = 255 / (screen.greys - 1);
    this.greyLuminance = Math.round(Math.round(GREY_LUMINANCE / step) * step);
  }

  private paintAt(paint: Paint, x: number, y: number): number {
    if (paint === "ink") return 0;
    if (paint === "paper") return 255;
    if (this.greys > 2) return this.greyLuminance;
    return (x + y) % 2 === 0 ? 0 : 255;
  }

  private blend(x: number, y: number, coverage: number, paint: Paint): void {
    const i = y * this.width + x;
    const dst = this.luminance[i]!;
    const src = this.paintAt(paint, x, y);
    this.luminance[i] = coverage >= 1 ? src : Math.round(dst + (src - dst) * coverage);
  }

  fillRect(x: number, y: number, width: number, height: number, paint: Paint): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + width));
    const y1 = Math.min(this.height, Math.round(y + height));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.blend(px, py, 1, paint);
    }
  }

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

  toFrame(): Frame {
    const max = this.greys - 1;
    const levelOf = Uint8Array.from({ length: 256 }, (_, l) => Math.round((l * max) / 255));
    const levels = new Uint8Array(this.luminance.length);
    for (let i = 0; i < levels.length; i += 1) levels[i] = levelOf[this.luminance[i]!]!;
    return { width: this.width, height: this.height, greys: this.greys, levels };
  }
}

const HALF_SQRT2 = 0.7071067811865476;
const TAN_EIGHTH = 0.41421356237309503;

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

export function addPolyline(path: Path, points: number[], width: number): Path {
  const r = width / 2;
  for (let i = 0; i + 3 < points.length; i += 2) {
    addSegment(path, points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, r);
  }
  for (let i = 0; i + 1 < points.length; i += 2) addCircle(path, points[i]!, points[i + 1]!, r);
  return path;
}

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
