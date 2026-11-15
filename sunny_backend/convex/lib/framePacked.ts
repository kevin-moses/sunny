import type { Frame } from "./frameRaster";

export const PACKED_MAGIC = [0x53, 0x4e, 0x59, 0x46] as const;

export const PACKED_VERSION = 1;

export const PACKED_HEADER_BYTES = 16;

export const PACKED_ENCODING = { raw: 0, packBits: 1 } as const;

export const PACKED_HEADER_OFFSET = {
  magic: 0,
  version: 4,
  bitsPerPixel: 5,
  encoding: 6,
  maxGreyLevel: 7,
  widthUint16: 8,
  heightUint16: 10,
  payloadBytesUint32: 12,
} as const;

export const PACKED_LITTLE_ENDIAN = true;

const UNUSED_ROW_BITS_FILL = 0xff;

const PACKBITS_MAX_RUN = 128;

export const PACKBITS_NO_OP = 128;

const PACKBITS_MIN_REPEAT = 3;

function bitsPerPixel(greys: number): number {
  for (const bpp of [1, 2, 4]) if (greys <= 2 ** bpp) return bpp;
  return 8;
}

export function packPixels(frame: Frame): Uint8Array {
  const bpp = bitsPerPixel(frame.greys);
  const rowBytes = Math.ceil((frame.width * bpp) / 8);
  const out = new Uint8Array(rowBytes * frame.height).fill(UNUSED_ROW_BITS_FILL);
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

export function packBits(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + Math.ceil(data.length / PACKBITS_MAX_RUN));
  let o = 0;
  const runAt = (i: number): number => {
    let run = 1;
    while (i + run < data.length && run < PACKBITS_MAX_RUN && data[i + run] === data[i]) run += 1;
    return run;
  };
  let i = 0;
  while (i < data.length) {
    const run = runAt(i);
    if (run >= PACKBITS_MIN_REPEAT) {
      out[o++] = 257 - run;
      out[o++] = data[i]!;
      i += run;
      continue;
    }
    let end = i;
    while (end < data.length && end - i < PACKBITS_MAX_RUN && runAt(end) < PACKBITS_MIN_REPEAT) {
      end += 1;
    }
    out[o++] = end - i - 1;
    out.set(data.subarray(i, end), o);
    o += end - i;
    i = end;
  }
  return out.subarray(0, o);
}

export function encodePacked(frame: Frame): Uint8Array<ArrayBuffer> {
  const payload = packBits(packPixels(frame));
  const out = new Uint8Array(PACKED_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  const at = PACKED_HEADER_OFFSET;
  out.set(PACKED_MAGIC, at.magic);
  out[at.version] = PACKED_VERSION;
  out[at.bitsPerPixel] = bitsPerPixel(frame.greys);
  out[at.encoding] = PACKED_ENCODING.packBits;
  out[at.maxGreyLevel] = frame.greys - 1;
  view.setUint16(at.widthUint16, frame.width, PACKED_LITTLE_ENDIAN);
  view.setUint16(at.heightUint16, frame.height, PACKED_LITTLE_ENDIAN);
  view.setUint32(at.payloadBytesUint32, payload.length, PACKED_LITTLE_ENDIAN);
  out.set(payload, PACKED_HEADER_BYTES);
  return out;
}
