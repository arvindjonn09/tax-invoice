import { crc32 } from "node:zlib";

// Synthetic images for the logo checks (#227): built byte by byte, so each
// test states exactly what the file contains.

export function pngChunk(name: string, data: Uint8Array = new Uint8Array()) {
  const body = Buffer.concat([Buffer.from(name, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function ihdr(width = 1, height = 1, depth = 8, colourType = 6) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = depth;
  data[9] = colourType;
  return pngChunk("IHDR", data);
}

export const IDAT = pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60]));
export const IEND = pngChunk("IEND");

export function png(
  { width = 1, height = 1 } = {},
  ...extra: readonly Buffer[]
): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    ...extra,
    IDAT,
    IEND,
  ]);
}

export function jpegSegment(
  marker: number,
  data: Uint8Array = Buffer.alloc(0),
) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.byteLength + 2, 2);
  return Buffer.concat([head, data]);
}

export const SOI = Buffer.from([0xff, 0xd8]);
export const EOI = Buffer.from([0xff, 0xd9]);
export const JFIF = jpegSegment(
  0xe0,
  Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
);
export const QUANT = jpegSegment(0xdb, Buffer.alloc(65, 1));
export const HUFFMAN = jpegSegment(0xc4, Buffer.alloc(17, 0));
/** The scan header, then coded data with an escaped 0xFF and a restart marker. */
export const SCAN = Buffer.concat([
  jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
]);

export function sof(width = 1, height = 1) {
  const data = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  data.writeUInt16BE(height, 1);
  data.writeUInt16BE(width, 3);
  return jpegSegment(0xc0, data);
}

export function jpeg(
  { width = 1, height = 1 } = {},
  ...extra: readonly Buffer[]
): Buffer {
  return Buffer.concat([
    SOI,
    JFIF,
    ...extra,
    QUANT,
    sof(width, height),
    HUFFMAN,
    SCAN,
    EOI,
  ]);
}
