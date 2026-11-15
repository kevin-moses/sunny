// lib/frameIcons.ts
// Purpose: The small pictures of the server-drawn display frames, drawn as filled paths in a
// square box so they scale with the screen: one per device-state icon name (pills, calendar,
// checklist, bell, clock; lib/deviceWording.ts DeviceIcon), plus the checkmark of finished rows
// and progress boxes, the microphone of the Talk keycap and the walking figure of the going-out
// strip. They stand in for the SF Symbols the iPad draws (sunny_app/src/display/DisplayParts.tsx)
// with the same bold, simple weight; nothing here looks pressable. Shapes with an inside (the
// calendar's frame, the clock's ring) are drawn ink first and then paper over, so every path is
// filled in one winding direction.
//
// Last modified: 2026-11-14

import type { DeviceIcon } from "./deviceWording";
import { Path, addCircle, addPolyline, addRoundRect, addSegment } from "./frameRaster";
import type { Canvas, Paint } from "./frameRaster";

/** Every icon a frame draws. */
export type FrameIcon = DeviceIcon | "checkmark" | "mic" | "walk";

/** A box in pixels with a drawing scale: unit coordinates 0..1 map onto it. */
interface Box {
  x: number;
  y: number;
  size: number;
}

/**
 * purpose: Unit coordinates (pairs in 0..1) to pixel coordinates in a box.
 * @param box: (Box) The box.
 * @param units: (number[]) x, y pairs.
 * @return: (number[]) Pixel pairs.
 */
function toPixels(box: Box, units: number[]): number[] {
  return units.map((v, i) => (i % 2 === 0 ? box.x : box.y) + v * box.size);
}

/**
 * purpose: Fill a thick polyline given in unit coordinates.
 * @param canvas: (Canvas) The canvas.
 * @param box: (Box) The box.
 * @param units: (number[]) x, y pairs in 0..1.
 * @param width: (number) Line width as a fraction of the box.
 * @param paint: (Paint) The paint.
 * @return: (void)
 */
function line(canvas: Canvas, box: Box, units: number[], width: number, paint: Paint): void {
  canvas.fillPath(addPolyline(new Path(), toPixels(box, units), width * box.size), paint);
}

/**
 * purpose: Fill a thick straight segment with square (butt) ends, given in unit coordinates.
 * @param canvas: (Canvas) The canvas.
 * @param box: (Box) The box.
 * @param units: ([number, number, number, number]) Start x, y and end x, y in 0..1.
 * @param width: (number) Width as a fraction of the box.
 * @param paint: (Paint) The paint.
 * @return: (void)
 */
function bar(
  canvas: Canvas,
  box: Box,
  units: [number, number, number, number],
  width: number,
  paint: Paint,
): void {
  const [x0, y0, x1, y1] = toPixels(box, units) as [number, number, number, number];
  canvas.fillPath(addSegment(new Path(), x0, y0, x1, y1, (width * box.size) / 2), paint);
}

/**
 * purpose: Fill a circle given in unit coordinates.
 * @param canvas: (Canvas) The canvas.
 * @param box: (Box) The box.
 * @param cx: (number) Center x in 0..1.
 * @param cy: (number) Center y in 0..1.
 * @param r: (number) Radius as a fraction of the box.
 * @param paint: (Paint) The paint.
 * @return: (void)
 */
function circle(canvas: Canvas, box: Box, cx: number, cy: number, r: number, paint: Paint): void {
  const s = box.size;
  canvas.fillPath(addCircle(new Path(), box.x + cx * s, box.y + cy * s, r * s), paint);
}

/**
 * purpose: Fill a rounded rectangle given in unit coordinates.
 * @param canvas: (Canvas) The canvas.
 * @param box: (Box) The box.
 * @param rect: ([number, number, number, number, number]) x, y, width, height, radius in 0..1.
 * @param paint: (Paint) The paint.
 * @return: (void)
 */
function roundRect(
  canvas: Canvas,
  box: Box,
  rect: [number, number, number, number, number],
  paint: Paint,
): void {
  const s = box.size;
  const [x, y, w, h, r] = rect;
  canvas.fillPath(
    addRoundRect(new Path(), box.x + x * s, box.y + y * s, w * s, h * s, r * s),
    paint,
  );
}

/**
 * purpose: Draw an icon in a square box.
 * @param canvas: (Canvas) The canvas.
 * @param icon: (FrameIcon) Which icon.
 * @param x: (number) Box left in pixels.
 * @param y: (number) Box top in pixels.
 * @param size: (number) Box side in pixels.
 * @param paint: (Paint) The ink (the icon's own insides are paper, or `background`).
 * @param background: (Paint) What the icon sits on (default paper).
 * @return: (void)
 */
export function drawIcon(
  canvas: Canvas,
  icon: FrameIcon,
  x: number,
  y: number,
  size: number,
  paint: Paint,
  background: Paint = "paper",
): void {
  const box = { x, y, size };
  switch (icon) {
    case "checkmark":
      line(canvas, box, [0.14, 0.53, 0.4, 0.78, 0.86, 0.22], 0.15, paint);
      return;
    case "pills":
      // A capsule on the diagonal, its lower half filled.
      line(canvas, box, [0.26, 0.74, 0.74, 0.26], 0.46, paint);
      line(canvas, box, [0.26, 0.74, 0.74, 0.26], 0.28, background);
      line(canvas, box, [0.26, 0.74, 0.38, 0.62], 0.28, paint);
      bar(canvas, box, [0.38, 0.62, 0.5, 0.5], 0.28, paint);
      bar(canvas, box, [0.34, 0.34, 0.66, 0.66], 0.09, paint);
      return;
    case "calendar":
      roundRect(canvas, box, [0.1, 0.16, 0.8, 0.74, 0.12], paint);
      roundRect(canvas, box, [0.19, 0.38, 0.62, 0.43, 0.04], background);
      line(canvas, box, [0.32, 0.08, 0.32, 0.22], 0.1, paint);
      line(canvas, box, [0.68, 0.08, 0.68, 0.22], 0.1, paint);
      for (const [cx, cy] of [
        [0.33, 0.5],
        [0.5, 0.5],
        [0.67, 0.5],
        [0.33, 0.68],
        [0.5, 0.68],
      ] as const) {
        roundRect(canvas, box, [cx - 0.06, cy - 0.055, 0.12, 0.11, 0.02], paint);
      }
      return;
    case "checklist":
      for (const row of [0.22, 0.5, 0.78]) {
        line(canvas, box, [0.08, row, 0.16, row + 0.08, 0.3, row - 0.08], 0.08, paint);
        line(canvas, box, [0.44, row, 0.92, row], 0.1, paint);
      }
      return;
    case "bell": {
      const s = box.size;
      const path = new Path();
      const p = (u: number, v: number): [number, number] => [box.x + u * s, box.y + v * s];
      path.moveTo(...p(0.5, 0.1));
      path.quadTo(...p(0.8, 0.1), ...p(0.8, 0.45));
      path.lineTo(...p(0.8, 0.6));
      path.lineTo(...p(0.92, 0.74));
      path.lineTo(...p(0.08, 0.74));
      path.lineTo(...p(0.2, 0.6));
      path.lineTo(...p(0.2, 0.45));
      path.quadTo(...p(0.2, 0.1), ...p(0.5, 0.1));
      canvas.fillPath(path.close(), paint);
      circle(canvas, box, 0.5, 0.84, 0.1, paint);
      return;
    }
    case "clock":
      circle(canvas, box, 0.5, 0.5, 0.44, paint);
      circle(canvas, box, 0.5, 0.5, 0.33, background);
      line(canvas, box, [0.5, 0.28, 0.5, 0.5, 0.66, 0.6], 0.09, paint);
      return;
    case "mic":
      roundRect(canvas, box, [0.33, 0.06, 0.34, 0.54, 0.17], paint);
      roundRect(canvas, box, [0.42, 0.15, 0.16, 0.36, 0.08], background);
      line(
        canvas,
        box,
        [0.2, 0.42, 0.22, 0.56, 0.32, 0.67, 0.5, 0.72, 0.68, 0.67, 0.78, 0.56, 0.8, 0.42],
        0.09,
        paint,
      );
      line(canvas, box, [0.5, 0.72, 0.5, 0.92], 0.09, paint);
      return;
    case "walk":
      circle(canvas, box, 0.58, 0.12, 0.1, paint);
      line(canvas, box, [0.55, 0.3, 0.46, 0.58], 0.14, paint);
      line(canvas, box, [0.28, 0.48, 0.42, 0.34, 0.55, 0.32, 0.64, 0.46, 0.76, 0.52], 0.1, paint);
      line(canvas, box, [0.46, 0.58, 0.36, 0.74, 0.24, 0.92], 0.12, paint);
      line(canvas, box, [0.46, 0.58, 0.62, 0.72, 0.66, 0.92], 0.12, paint);
      return;
  }
}
