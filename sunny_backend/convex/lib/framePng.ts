import type { Frame } from "./frameRaster";

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

const WINDOW = 32768;
const MAX_MATCH = 258;
const MAX_CHAIN = 64;
const HASH_SIZE = 1 << 15;

class BitWriter {
  private bytes: Uint8Array;
  private length = 0;
  private bits = 0;
  private count = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(Math.max(64, capacity));
  }

  private push(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length] = byte;
    this.length += 1;
  }

  put(value: number, n: number): void {
    for (let i = 0; i < n; i += 1) {
      this.bits |= ((value >>> i) & 1) << this.count;
      this.count += 1;
      if (this.count === 8) {
        this.push(this.bits);
        this.bits = 0;
        this.count = 0;
      }
    }
  }

  putCode(code: number, n: number): void {
    for (let i = n - 1; i >= 0; i -= 1) this.put((code >>> i) & 1, 1);
  }

  finish(): Uint8Array {
    if (this.count > 0) this.push(this.bits);
    this.bits = 0;
    this.count = 0;
    return this.bytes.subarray(0, this.length);
  }
}

function putSymbol(out: BitWriter, symbol: number): void {
  if (symbol < 144) out.putCode(0x30 + symbol, 8);
  else if (symbol < 256) out.putCode(0x190 + symbol - 144, 9);
  else if (symbol < 280) out.putCode(symbol - 256, 7);
  else out.putCode(0xc0 + symbol - 280, 8);
}

function codeIndex(table: number[], value: number): number {
  let i = table.length - 1;
  while (table[i]! > value) i -= 1;
  return i;
}

function putMatch(out: BitWriter, length: number, distance: number): void {
  const l = codeIndex(LENGTH_BASE, length);
  putSymbol(out, 257 + l);
  out.put(length - LENGTH_BASE[l]!, LENGTH_EXTRA[l]!);
  const d = codeIndex(DISTANCE_BASE, distance);
  out.putCode(d, 5);
  out.put(distance - DISTANCE_BASE[d]!, DISTANCE_EXTRA[d]!);
}

function deflate(data: Uint8Array): Uint8Array {
  const out = new BitWriter((data.length >> 4) + 1024);
  out.put(1, 1);
  out.put(1, 2);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WINDOW);
  const hash = (i: number): number =>
    ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & (HASH_SIZE - 1);
  const insert = (i: number): void => {
    if (i + 2 >= data.length) return;
    const h = hash(i);
    prev[i & (WINDOW - 1)] = head[h]!;
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
        if (bestLength > 0 && data[candidate + bestLength] !== data[i + bestLength]) {
          candidate = prev[candidate & (WINDOW - 1)]!;
          continue;
        }
        let length = 0;
        while (length < limit && data[candidate + length] === data[i + length]) length += 1;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = i - candidate;
          if (length === limit) break;
        }
        candidate = prev[candidate & (WINDOW - 1)]!;
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

const ADLER_MODULUS = 65521;

const ZLIB_ADLER_NMAX = 5552;

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let start = 0; start < data.length; start += ZLIB_ADLER_NMAX) {
    const end = Math.min(data.length, start + ZLIB_ADLER_NMAX);
    for (let i = start; i < end; i += 1) {
      a += data[i]!;
      b += a;
    }
    a %= ADLER_MODULUS;
    b %= ADLER_MODULUS;
  }
  return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zlib(data: Uint8Array): Uint8Array {
  const body = deflate(data);
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(body.length + 2, adler32(data));
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

function pngDepth(greys: number): { depth: number; sample: (level: number) => number } {
  for (const depth of [1, 2, 4, 8]) {
    if (greys === 2 ** depth) return { depth, sample: (level) => level };
  }
  return { depth: 8, sample: (level) => Math.round((level * 255) / (greys - 1)) };
}

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
