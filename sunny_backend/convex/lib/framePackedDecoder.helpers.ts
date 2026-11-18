import {
  PACKBITS_NO_OP,
  PACKED_ENCODING,
  PACKED_HEADER_BYTES,
  PACKED_HEADER_OFFSET,
  PACKED_LITTLE_ENDIAN,
  PACKED_MAGIC,
  PACKED_VERSION,
} from "./framePacked";
import type { Frame } from "./frameRaster";

export interface PackedHeader {
  version: number;
  bitsPerPixel: number;
  encoding: number;
  greys: number;
  width: number;
  height: number;
  payloadBytes: number;
}

export function readPackedHeader(bytes: Uint8Array): PackedHeader {
  if (bytes.length < PACKED_HEADER_BYTES || PACKED_MAGIC.some((m, i) => bytes[i] !== m)) {
    throw new Error("not a packed frame");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = PACKED_HEADER_OFFSET;
  const header = {
    version: bytes[at.version]!,
    bitsPerPixel: bytes[at.bitsPerPixel]!,
    encoding: bytes[at.encoding]!,
    greys: bytes[at.maxGreyLevel]! + 1,
    width: view.getUint16(at.widthUint16, PACKED_LITTLE_ENDIAN),
    height: view.getUint16(at.heightUint16, PACKED_LITTLE_ENDIAN),
    payloadBytes: view.getUint32(at.payloadBytesUint32, PACKED_LITTLE_ENDIAN),
  };
  if (header.version !== PACKED_VERSION) throw new Error("unknown packed frame version");
  if (![1, 2, 4, 8].includes(header.bitsPerPixel)) throw new Error("bad bits per pixel");
  if (header.greys > 2 ** header.bitsPerPixel) throw new Error("more levels than bits");
  if (bytes.length !== PACKED_HEADER_BYTES + header.payloadBytes) throw new Error("bad length");
  return header;
}

export function decodePayload(payload: Uint8Array, encoding: number, expected: number): Uint8Array {
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
    if (n === PACKBITS_NO_OP) continue;
    const literal = n < PACKBITS_NO_OP;
    const count = literal ? n + 1 : 257 - n;
    if (o + count > expected || i + (literal ? count : 1) > payload.length) {
      throw new Error("payload overruns the frame");
    }
    if (literal) {
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
