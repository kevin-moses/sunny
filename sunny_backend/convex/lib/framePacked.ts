// lib/framePacked.ts
// Purpose: The packed frame format the e-ink display's firmware reads (GET /device/frame
// ?format=packed), with its encoder and a decoder (used by the tests; the firmware's decoder is
// a C port of decodePayload). The firmware is written against this comment and notes/HANDOFF.md.
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
// A streaming decoder needs a control byte, a remaining count and a repeat byte, and can hand
// each finished row (240 bytes at 960 x 2 bpp) to the panel driver as it fills.
//
// Last modified: 2026-11-14

import type { Frame } from "./frameRaster";

/** "SNYF". */
const MAGIC = [0x53, 0x4e, 0x59, 0x46] as const;

/** The packed format's version. */
const PACKED_VERSION = 1;

/** Header size in bytes. */
export const PACKED_HEADER_BYTES = 16;

/** Payload encodings. */
const PACKED_ENCODING = { raw: 0, packBits: 1 } as const;

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
 * purpose: PackBits encoding: runs of 3 or more equal bytes as repeats, the rest as literals.
 * @param data: (Uint8Array) The bytes.
 * @return: (Uint8Array) The encoded bytes.
 */
export function packBits(data: Uint8Array): Uint8Array {
  const out: number[] = [];
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
      out.push(257 - run, data[i]!);
      i += run;
      continue;
    }
    let end = i;
    while (end < data.length && end - i < 128 && runAt(end) < 3) end += 1;
    out.push(end - i - 1);
    for (let k = i; k < end; k += 1) out.push(data[k]!);
    i = end;
  }
  return Uint8Array.from(out);
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
  out.set(MAGIC, 0);
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

/** The fields of a packed header. */
export interface PackedHeader {
  version: number;
  bitsPerPixel: number;
  encoding: number;
  greys: number;
  width: number;
  height: number;
  payloadBytes: number;
}

/**
 * purpose: Read and check a packed header.
 * @param bytes: (Uint8Array) The file.
 * @return: (PackedHeader) The fields.
 * @raises Error for a wrong magic, version, encoding, depth or length.
 */
export function readPackedHeader(bytes: Uint8Array): PackedHeader {
  if (bytes.length < PACKED_HEADER_BYTES || MAGIC.some((m, i) => bytes[i] !== m)) {
    throw new Error("not a packed frame");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    version: bytes[4]!,
    bitsPerPixel: bytes[5]!,
    encoding: bytes[6]!,
    greys: bytes[7]! + 1,
    width: view.getUint16(8, true),
    height: view.getUint16(10, true),
    payloadBytes: view.getUint32(12, true),
  };
  if (header.version !== PACKED_VERSION) throw new Error("unknown packed frame version");
  if (![1, 2, 4, 8].includes(header.bitsPerPixel)) throw new Error("bad bits per pixel");
  if (header.greys > 2 ** header.bitsPerPixel) throw new Error("more levels than bits");
  if (bytes.length !== PACKED_HEADER_BYTES + header.payloadBytes) throw new Error("bad length");
  return header;
}

/**
 * purpose: Decode a payload into pixel bytes, as a streaming firmware decoder would.
 * @param payload: (Uint8Array) The payload.
 * @param encoding: (number) PACKED_ENCODING value.
 * @param expected: (number) Pixel bytes the header promises.
 * @return: (Uint8Array) The pixel bytes.
 * @raises Error when the payload does not decode to exactly `expected` bytes.
 */
function decodePayload(payload: Uint8Array, encoding: number, expected: number): Uint8Array {
  if (encoding === PACKED_ENCODING.raw) {
    if (payload.length !== expected) throw new Error("bad raw payload length");
    return payload.slice();
  }
  if (encoding !== PACKED_ENCODING.packBits) throw new Error("unknown encoding");
  const out = new Uint8Array(expected);
  let o = 0;
  let i = 0;
  while (i < payload.length) {
    const n = payload[i++]!;
    if (n === 128) continue;
    const count = n < 128 ? n + 1 : 257 - n;
    if (o + count > expected || i + (n < 128 ? count : 1) > payload.length) {
      throw new Error("payload overruns the frame");
    }
    if (n < 128) {
      out.set(payload.subarray(i, i + count), o);
      i += count;
    } else {
      out.fill(payload[i++]!, o, o + count);
    }
    o += count;
  }
  if (o !== expected) throw new Error("payload ends early");
  return out;
}

/**
 * purpose: Decode a packed frame (the round trip of encodePacked).
 * @param bytes: (Uint8Array) The file.
 * @return: (Frame) The frame.
 * @raises Error for a malformed file.
 */
export function decodePacked(bytes: Uint8Array): Frame {
  const header = readPackedHeader(bytes);
  const { width, height, greys } = header;
  const bpp = header.bitsPerPixel;
  const rowBytes = Math.ceil((width * bpp) / 8);
  const pixels = decodePayload(
    bytes.subarray(PACKED_HEADER_BYTES),
    header.encoding,
    rowBytes * height,
  );
  const levels = new Uint8Array(width * height);
  const mask = (1 << bpp) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bit = x * bpp;
      levels[y * width + x] = (pixels[y * rowBytes + (bit >> 3)]! >> (8 - bpp - (bit & 7))) & mask;
    }
  }
  return { width, height, greys, levels };
}
