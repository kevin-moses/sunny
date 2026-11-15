// lib/framePng.ts
// Purpose: PNG encoding of a display frame (lib/frameRaster.ts Frame), for the iPad stand-in,
// previews and golden tests. Greyscale (colour type 0) at the bit depth that holds the frame's
// levels exactly: 1 bit for 2 greys, 2 for 4, 4 for 16, 8 for 256; any other grey count is
// written at 8 bits with level l as round(l * 255 / (greys - 1)). Rows use filter 0.
//
// The zlib stream is made here, with no dependency: one deflate block with the fixed Huffman
// codes and greedy LZ77 matching (hash chains over the last 32 KiB). Frames are mostly paper
// and repeated rows, which that compresses well (a 960 x 680 x 4 frame is a few kilobytes), and
// the output is byte-for-byte deterministic, which a platform compressor (CompressionStream,
// not documented in the Convex runtime) would not promise across versions.
//
// Last modified: 2026-11-14

import type { Frame } from "./frameRaster";

/** Deflate length codes 257..285: base length and extra bits. */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

/** Deflate distance codes 0..29: base distance and extra bits. */
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** LZ77 limits: window, longest match, candidates tried per position. */
const WINDOW = 32768;
const MAX_MATCH = 258;
const MAX_CHAIN = 64;
const HASH_SIZE = 1 << 15;

/** A little-endian bit writer (deflate's bit order). */
class BitWriter {
  private bytes: number[] = [];
  private bits = 0;
  private count = 0;

  /**
   * purpose: Write the low `n` bits of a value, least significant first.
   * @param value: (number) The bits.
   * @param n: (number) How many.
   * @return: (void)
   */
  put(value: number, n: number): void {
    for (let i = 0; i < n; i += 1) {
      this.bits |= ((value >>> i) & 1) << this.count;
      this.count += 1;
      if (this.count === 8) {
        this.bytes.push(this.bits);
        this.bits = 0;
        this.count = 0;
      }
    }
  }

  /**
   * purpose: Write a Huffman code, most significant bit first (deflate's code order).
   * @param code: (number) The code.
   * @param n: (number) Its length.
   * @return: (void)
   */
  putCode(code: number, n: number): void {
    for (let i = n - 1; i >= 0; i -= 1) this.put((code >>> i) & 1, 1);
  }

  /**
   * purpose: Pad to a byte and return the bytes.
   * @return: (Uint8Array) The stream.
   */
  finish(): Uint8Array {
    if (this.count > 0) this.bytes.push(this.bits);
    this.bits = 0;
    this.count = 0;
    return Uint8Array.from(this.bytes);
  }
}

/**
 * purpose: Write a literal/length symbol with the fixed Huffman code.
 * @param out: (BitWriter) The writer.
 * @param symbol: (number) 0 to 287.
 * @return: (void)
 */
function putSymbol(out: BitWriter, symbol: number): void {
  if (symbol < 144) out.putCode(0x30 + symbol, 8);
  else if (symbol < 256) out.putCode(0x190 + symbol - 144, 9);
  else if (symbol < 280) out.putCode(symbol - 256, 7);
  else out.putCode(0xc0 + symbol - 280, 8);
}

/**
 * purpose: The index of the last table entry not greater than a value.
 * @param table: (number[]) Ascending bases.
 * @param value: (number) The value.
 * @return: (number) The index.
 */
function codeIndex(table: number[], value: number): number {
  let i = table.length - 1;
  while (table[i]! > value) i -= 1;
  return i;
}

/**
 * purpose: Write one match (length 3 to 258, distance 1 to 32768).
 * @param out: (BitWriter) The writer.
 * @param length: (number) Match length.
 * @param distance: (number) Match distance.
 * @return: (void)
 */
function putMatch(out: BitWriter, length: number, distance: number): void {
  const l = codeIndex(LENGTH_BASE, length);
  putSymbol(out, 257 + l);
  out.put(length - LENGTH_BASE[l]!, LENGTH_EXTRA[l]!);
  const d = codeIndex(DISTANCE_BASE, distance);
  out.putCode(d, 5);
  out.put(distance - DISTANCE_BASE[d]!, DISTANCE_EXTRA[d]!);
}

/**
 * purpose: Raw deflate (RFC 1951) of bytes: one final block, fixed Huffman codes, greedy LZ77.
 * @param data: (Uint8Array) The input.
 * @return: (Uint8Array) The deflate stream.
 */
function deflate(data: Uint8Array): Uint8Array {
  const out = new BitWriter();
  out.put(1, 1);
  out.put(1, 2);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length);
  /**
   * purpose: The hash of the three bytes at a position.
   * @param i: (number) Position (with two bytes after it).
   * @return: (number) The hash.
   */
  const hash = (i: number): number =>
    ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & (HASH_SIZE - 1);
  /**
   * purpose: Record a position in its hash chain.
   * @param i: (number) Position.
   * @return: (void)
   */
  const insert = (i: number): void => {
    if (i + 2 >= data.length) return;
    const h = hash(i);
    prev[i] = head[h]!;
    head[h] = i;
  };
  let i = 0;
  while (i < data.length) {
    let bestLength = 0;
    let bestDistance = 0;
    if (i + 2 < data.length) {
      let candidate = head[hash(i)]!;
      const limit = Math.min(MAX_MATCH, data.length - i);
      for (
        let tries = 0;
        candidate >= 0 && i - candidate <= WINDOW && tries < MAX_CHAIN;
        tries += 1
      ) {
        // A candidate that differs at the best length so far cannot beat it (zlib's check).
        if (bestLength > 0 && data[candidate + bestLength] !== data[i + bestLength]) {
          candidate = prev[candidate]!;
          continue;
        }
        let length = 0;
        while (length < limit && data[candidate + length] === data[i + length]) length += 1;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = i - candidate;
          if (length === limit) break;
        }
        candidate = prev[candidate]!;
      }
    }
    if (bestLength >= 3) {
      putMatch(out, bestLength, bestDistance);
      for (let k = 0; k < bestLength; k += 1) insert(i + k);
      i += bestLength;
    } else {
      putSymbol(out, data[i]!);
      insert(i);
      i += 1;
    }
  }
  putSymbol(out, 256);
  return out.finish();
}

/**
 * purpose: Adler-32 of bytes (the zlib trailer).
 * @param data: (Uint8Array) The bytes.
 * @return: (number) The checksum.
 */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  // Reduce every 5552 bytes (zlib's NMAX), the most that cannot overflow before the modulo.
  for (let start = 0; start < data.length; start += 5552) {
    const end = Math.min(data.length, start + 5552);
    for (let i = start; i < end; i += 1) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** CRC-32 table (polynomial 0xEDB88320). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * purpose: CRC-32 of bytes (PNG chunks).
 * @param data: (Uint8Array) The bytes.
 * @return: (number) The CRC.
 */
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * purpose: A zlib stream (RFC 1950) of bytes.
 * @param data: (Uint8Array) The bytes.
 * @return: (Uint8Array) Header, deflate data, Adler-32.
 */
function zlib(data: Uint8Array): Uint8Array {
  const body = deflate(data);
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(body.length + 2, adler32(data));
  return out;
}

/**
 * purpose: One PNG chunk: length, type, data, CRC over type and data.
 * @param type: (string) Four-letter type.
 * @param data: (Uint8Array) The data.
 * @return: (Uint8Array) The chunk.
 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

/**
 * purpose: The PNG bit depth for a grey count, and the sample written for a level.
 * @param greys: (number) Grey levels.
 * @return: ({ depth: number; sample: (level: number) => number }) Depth and level mapping.
 */
function pngDepth(greys: number): { depth: number; sample: (level: number) => number } {
  for (const depth of [1, 2, 4, 8]) {
    if (greys === 2 ** depth) return { depth, sample: (level) => level };
  }
  return { depth: 8, sample: (level) => Math.round((level * 255) / (greys - 1)) };
}

/**
 * purpose: Encode a frame as a greyscale PNG.
 * @param frame: (Frame) The frame.
 * @return: (Uint8Array) The PNG file.
 */
export function encodePng(frame: Frame): Uint8Array<ArrayBuffer> {
  const { width, height, levels } = frame;
  const { depth, sample } = pngDepth(frame.greys);
  const rowBytes = Math.ceil((width * depth) / 8);
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x += 1) {
      const bit = x * depth;
      raw[row + (bit >> 3)]! |= sample(levels[y * width + x]!) << (8 - depth - (bit & 7));
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = depth;
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
