// lib/framePacked.ts
// Purpose: The packed frame format the e-ink display's firmware reads (GET /device/frame
// ?format=packed), and its encoder. The firmware is written against this comment and
// notes/HANDOFF.md "Display frames"; lib/framePackedDecoder.helpers.ts is a reference decoder
// (used by the tests, kept out of the deployed bundle) that a firmware decoder can port.
//
// Layout: a 16-byte header, then the payload. All multi-byte fields little-endian.
//   offset  size  field
//   0       4     magic, the ASCII bytes "SNYF" (0x53 0x4E 0x59 0x46)
//   4       1     format version, 1
//   5       1     bits per pixel: 1, 2, 4 or 8, the fewest that hold every level
//   6       1     encoding: 0 = raw, 1 = PackBits run-length (what the server sends)
//   7       1     the highest grey level, greys - 1 (1 for a 1-bit panel, 3 for 4 greys)
//   8       2     width in pixels (uint16)
//   10      2     height in pixels (uint16)
//   12      4     payload length in bytes (uint32), the bytes after the header
// Pixels (the decoded payload): rows top to bottom, each row ceil(width * bpp / 8) bytes, pixels
// left to right, most significant bits first within a byte (with 2 bpp the first pixel is bits
// 7-6). A pixel's value is its grey level: 0 is black, the highest level is white, levels in
// between are evenly spaced greys (with 4 greys: 0 black, 1 dark grey, 2 light grey, 3 white).
// Unused bits at the end of a row are 1s and carry no pixel. The firmware maps levels to its
// panel's own codes (Waveshare's 1-bit buffers already use 1 for white).
// PackBits (as in TIFF and Apple's PackBits, over the whole pixel stream; runs may cross rows):
// read a control byte n;
//   n 0..127:   copy the next n + 1 bytes as they are;
//   n 129..255: repeat the next byte 257 - n times (2 to 128);
//   n 128:      no operation (never written by this encoder).
// A decoder must reject: a magic other than "SNYF"; a version it does not know (a later
// version may change anything after byte 4); an encoding other than 0 or 1; more levels than
// the bits per pixel hold; a file whose length is not 16 plus the payload length; and a payload
// that does not decode to exactly height * ceil(width * bpp / 8) bytes (a run that would write
// past that, or a payload that ends before it). The payload is never longer than the raw
// pixels plus one control byte per 128 of them, raw + ceil(raw / 128): for 960 x 680 at 2 bpp,
// raw is 163,200 bytes and the payload at most 164,475 (the file 164,491). A streaming decoder
// needs a control byte, a remaining count and a repeat byte, and can hand each finished row
// (240 bytes at 960 x 2 bpp) to the panel driver as it fills.
//
// Last modified: 2026-11-14

import type { Frame } from "./frameRaster";

/** "SNYF". */
export const PACKED_MAGIC = [0x53, 0x4e, 0x59, 0x46] as const;

/** The packed format's version. */
export const PACKED_VERSION = 1;

/** Header size in bytes. */
export const PACKED_HEADER_BYTES = 16;

/** Payload encodings. */
export const PACKED_ENCODING = { raw: 0, packBits: 1 } as const;

/**
 * purpose: The fewest bits per pixel (1, 2, 4 or 8) that hold a grey count's levels.
 * @param greys: (number) Grey levels, 2 to 256.
 * @return: (number) Bits per pixel.
 */
function bitsPerPixel(greys: number): number {
  for (const bpp of [1, 2, 4]) if (greys <= 2 ** bpp) return bpp;
  return 8;
}

/**
 * purpose: Pack a frame's levels into rows of bytes, most significant bits first, unused row
 *          bits set to 1.
 * @param frame: (Frame) The frame.
 * @return: (Uint8Array) The pixel bytes.
 */
export function packPixels(frame: Frame): Uint8Array {
  const bpp = bitsPerPixel(frame.greys);
  const rowBytes = Math.ceil((frame.width * bpp) / 8);
  const out = new Uint8Array(rowBytes * frame.height).fill(0xff);
  const mask = (1 << bpp) - 1;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const bit = x * bpp;
      const at = y * rowBytes + (bit >> 3);
      const shift = 8 - bpp - (bit & 7);
      out[at] = (out[at]! & ~(mask << shift)) | (frame.levels[y * frame.width + x]! << shift);
    }
  }
  return out;
}

/**
 * purpose: PackBits encoding: runs of 3 or more equal bytes as repeats, the rest as literals of
 *          at most 128 bytes, written into one array of the largest size it can need
 *          (raw + ceil(raw / 128)).
 * @param data: (Uint8Array) The bytes.
 * @return: (Uint8Array) The encoded bytes (a view of that array).
 */
export function packBits(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + Math.ceil(data.length / 128));
  let o = 0;
  /**
   * purpose: Length of the run of equal bytes starting at a position (at most 128).
   * @param i: (number) Position.
   * @return: (number) Run length.
   */
  const runAt = (i: number): number => {
    let run = 1;
    while (i + run < data.length && run < 128 && data[i + run] === data[i]) run += 1;
    return run;
  };
  let i = 0;
  while (i < data.length) {
    const run = runAt(i);
    if (run >= 3) {
      out[o++] = 257 - run;
      out[o++] = data[i]!;
      i += run;
      continue;
    }
    let end = i;
    while (end < data.length && end - i < 128 && runAt(end) < 3) end += 1;
    out[o++] = end - i - 1;
    out.set(data.subarray(i, end), o);
    o += end - i;
    i = end;
  }
  return out.subarray(0, o);
}

/**
 * purpose: Encode a frame in the packed format (PackBits payload).
 * @param frame: (Frame) The frame (at most 65535 pixels a side).
 * @return: (Uint8Array) Header and payload.
 */
export function encodePacked(frame: Frame): Uint8Array<ArrayBuffer> {
  const payload = packBits(packPixels(frame));
  const out = new Uint8Array(PACKED_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  out.set(PACKED_MAGIC, 0);
  out[4] = PACKED_VERSION;
  out[5] = bitsPerPixel(frame.greys);
  out[6] = PACKED_ENCODING.packBits;
  out[7] = frame.greys - 1;
  view.setUint16(8, frame.width, true);
  view.setUint16(10, frame.height, true);
  view.setUint32(12, payload.length, true);
  out.set(payload, PACKED_HEADER_BYTES);
  return out;
}
