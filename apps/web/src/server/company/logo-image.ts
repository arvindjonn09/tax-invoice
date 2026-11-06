import { crc32 } from "node:zlib";

// #227. Pure TypeScript on purpose (no native image library in the upload
// path). The output is rebuilt from an allowlist of parts, so metadata and
// anything appended to the file can't reach storage.

/** 2 MiB and 4000 × 4000 px (S6 AC2). */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_SIDE = 4000;

export type CleanLogo = {
  type: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  width: number;
  height: number;
};
/** `type`: not a well-formed PNG or JPEG. `dimensions`: too many pixels. */
export type LogoCheck = CleanLogo | { refused: "type" | "dimensions" };

const NOT_AN_IMAGE = { refused: "type" } as const;

const fits = (width: number, height: number) =>
  width > 0 && height > 0 && width <= MAX_LOGO_SIDE && height <= MAX_LOGO_SIDE;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_KEPT = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
/** Bit depths the PNG specification allows for each colour type. */
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function cleanPng(file: Buffer): LogoCheck {
  const kept: Buffer[] = [file.subarray(0, 8)];
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let seenPalette = false;
  let seenData = false;
  let ended = false;
  while (offset < file.length) {
    if (ended || offset + 12 > file.length) return NOT_AN_IMAGE;
    const length = file.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > file.length) return NOT_AN_IMAGE;
    const name = file.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(name)) return NOT_AN_IMAGE;
    if (
      crc32(file.subarray(offset + 4, end - 4)) !== file.readUInt32BE(end - 4)
    )
      return NOT_AN_IMAGE;
    if ((name === "IHDR") !== (kept.length === 1)) return NOT_AN_IMAGE;
    // A critical chunk we don't know changes how the image decodes.
    if (!PNG_KEPT.has(name) && /^[A-Z]/.test(name)) return NOT_AN_IMAGE;
    const data = file.subarray(offset + 8, end - 4);
    if (name === "IHDR") {
      if (length !== 13) return NOT_AN_IMAGE;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data[9]!;
      if (
        !PNG_DEPTHS[colourType]?.includes(data[8]!) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12]! > 1
      )
        return NOT_AN_IMAGE;
      if (!fits(width, height)) return { refused: "dimensions" };
    }
    if (name === "PLTE") {
      if (seenData || seenPalette) return NOT_AN_IMAGE;
      seenPalette = true;
    }
    if (name === "IDAT") seenData = true;
    if (name === "IEND") {
      if (length !== 0 || !seenData) return NOT_AN_IMAGE;
      ended = true;
    }
    if (PNG_KEPT.has(name)) kept.push(file.subarray(offset, end));
    offset = end;
  }
  if (!ended || (colourType === 3 && !seenPalette)) return NOT_AN_IMAGE;
  return { type: "image/png", bytes: Buffer.concat(kept), width, height };
}

/** Start-of-frame markers: the baseline, progressive and other coded frames. */
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;
/** Huffman, quantisation, arithmetic-conditioning and restart tables. */
const JPEG_TABLES = new Set([0xc4, 0xdb, 0xcc, 0xdd]);

/** Where this scan's entropy-coded data ends, or -1 if the file stops first. */
function endOfScan(file: Buffer, start: number): number {
  let at = start;
  while (at + 1 < file.length) {
    if (file[at] !== 0xff) at += 1;
    else {
      const next = file[at + 1]!;
      if (next === 0xff) at += 1;
      else if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
      else return at;
    }
  }
  return -1;
}

function cleanJpeg(file: Buffer): LogoCheck {
  const kept: Buffer[] = [file.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  let seenFrame = false;
  let seenScan = false;
  for (;;) {
    if (offset + 2 > file.length || file[offset] !== 0xff) return NOT_AN_IMAGE;
    const marker = file[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // A fill byte.
      continue;
    }
    if (marker === 0xd9) {
      // Anything after the end-of-image marker is a polyglot's payload.
      if (!seenScan || offset + 2 !== file.length) return NOT_AN_IMAGE;
      kept.push(file.subarray(offset, offset + 2));
      break;
    }
    if (offset + 4 > file.length) return NOT_AN_IMAGE;
    const end = offset + 2 + file.readUInt16BE(offset + 2);
    if (end < offset + 4 || end > file.length) return NOT_AN_IMAGE;
    if (isStartOfFrame(marker)) {
      // Length, precision, height, width and count, then 3 bytes per component.
      if (
        seenFrame ||
        end < offset + 10 ||
        file[offset + 9] === 0 ||
        end !== offset + 10 + 3 * file[offset + 9]!
      )
        return NOT_AN_IMAGE;
      seenFrame = true;
      height = file.readUInt16BE(offset + 5);
      width = file.readUInt16BE(offset + 7);
      if (!fits(width, height)) return { refused: "dimensions" };
      kept.push(file.subarray(offset, end));
      offset = end;
    } else if (marker === 0xda) {
      if (!seenFrame) return NOT_AN_IMAGE;
      const scanEnd = endOfScan(file, end);
      if (scanEnd < 0) return NOT_AN_IMAGE;
      seenScan = true;
      kept.push(file.subarray(offset, scanEnd));
      offset = scanEnd;
    } else if (marker === 0xe0) {
      // Only the JFIF header, which sets the pixel density, rebuilt without
      // its thumbnail or anything else its length could carry.
      if (
        end >= offset + 18 &&
        file.toString("latin1", offset + 4, offset + 9) === "JFIF\0"
      ) {
        const header = Buffer.from(file.subarray(offset, offset + 18));
        header.writeUInt16BE(16, 2);
        header.writeUInt16BE(0, 16);
        kept.push(header);
      }
      offset = end;
    } else if (marker === 0xfe || (marker >= 0xe1 && marker <= 0xef)) {
      offset = end; // Comments and EXIF, XMP, ICC and other metadata.
    } else if (JPEG_TABLES.has(marker)) {
      kept.push(file.subarray(offset, end));
      offset = end;
    } else return NOT_AN_IMAGE;
  }
  return { type: "image/jpeg", bytes: Buffer.concat(kept), width, height };
}

/**
 * Check a logo by its bytes (never its name or declared type) and return a
 * copy holding only the parts needed to draw it. SVG, HTML and anything else
 * is refused, as is data added after the image ends.
 */
export function cleanLogo(bytes: Uint8Array): LogoCheck {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (PNG_SIGNATURE.every((byte, index) => file[index] === byte))
    return cleanPng(file);
  if (file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff)
    return cleanJpeg(file);
  return NOT_AN_IMAGE;
}
