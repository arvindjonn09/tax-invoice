import { describe, expect, it } from "vitest";
import {
  cleanLogo,
  MAX_LOGO_SIDE,
} from "../../apps/web/src/server/company/logo-image";
import {
  EOI,
  HUFFMAN,
  IDAT,
  IEND,
  ihdr,
  jpeg,
  jpegSegment,
  png,
  pngChunk,
  PNG_SIGNATURE,
  QUANT,
  SCAN,
  sof,
  SOI,
} from "../helpers/logo-fixtures";

const SECRET = "GPS -33.8688 151.2093 Canon";
const secret = Buffer.from(SECRET, "latin1");
const NOT_AN_IMAGE = { refused: "type" };
const TOO_BIG = { refused: "dimensions" };
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("logo checks: PNG (#227)", () => {
  it("keeps the image parts and removes text, EXIF and time chunks", () => {
    const plain = png({ width: 16, height: 9 });
    const tagged = png(
      { width: 16, height: 9 },
      pngChunk("tEXt", secret),
      pngChunk("iTXt", secret),
      pngChunk("zTXt", secret),
      pngChunk("eXIf", secret),
      pngChunk("tIME", secret),
    );
    const result = cleanLogo(tagged);
    expect(result).toMatchObject({ type: "image/png", width: 16, height: 9 });
    if ("refused" in result) throw new Error("refused");
    expect(latin1(result.bytes)).not.toContain(SECRET);
    expect(Buffer.from(result.bytes).equals(plain)).toBe(true);
  });

  it("keeps a palette and its transparency", () => {
    const plte = pngChunk("PLTE", Buffer.alloc(3));
    const trns = pngChunk("tRNS", Buffer.alloc(1));
    const file = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(1, 1, 8, 3),
      plte,
      trns,
      IDAT,
      IEND,
    ]);
    const result = cleanLogo(file);
    if ("refused" in result) throw new Error("refused");
    expect(Buffer.from(result.bytes).equals(file)).toBe(true);
  });

  it.each([
    ["1 × 1", 1, 1],
    ["the largest allowed", MAX_LOGO_SIDE, MAX_LOGO_SIDE],
  ])("accepts %s", (_name, width, height) => {
    expect(cleanLogo(png({ width, height }))).toMatchObject({ width, height });
  });

  it.each([
    ["too wide", MAX_LOGO_SIDE + 1, 1],
    ["too tall", 1, MAX_LOGO_SIDE + 1],
    ["a decompression bomb", 60_000, 60_000],
    ["zero wide", 0, 1],
  ])("refuses %s", (_name, width, height) => {
    expect(cleanLogo(png({ width, height }))).toEqual(TOO_BIG);
  });

  const corruptCrc = png();
  corruptCrc[corruptCrc.length - 1]! ^= 0xff;
  it.each<[string, Buffer]>([
    [
      "data after the image ends",
      Buffer.concat([png(), Buffer.from("<script>")]),
    ],
    ["a second image after the end", Buffer.concat([png(), IEND])],
    ["only a signature", PNG_SIGNATURE],
    ["no end chunk", Buffer.concat([PNG_SIGNATURE, ihdr(), IDAT])],
    ["no image data", Buffer.concat([PNG_SIGNATURE, ihdr(), IEND])],
    [
      "data before the header",
      Buffer.concat([PNG_SIGNATURE, IDAT, ihdr(), IEND]),
    ],
    [
      "a second header",
      Buffer.concat([PNG_SIGNATURE, ihdr(), ihdr(), IDAT, IEND]),
    ],
    ["a truncated chunk", png().subarray(0, 40)],
    [
      "a chunk longer than the file",
      Buffer.concat([
        PNG_SIGNATURE,
        Buffer.from([0x7f, 0, 0, 0]),
        Buffer.from("IHDR"),
        Buffer.alloc(8),
      ]),
    ],
    ["a bad checksum", corruptCrc],
    ["an unknown critical chunk", png({}, pngChunk("CgBI", Buffer.alloc(4)))],
    ["an invalid chunk name", png({}, pngChunk("t3Xt", secret))],
    [
      "an impossible colour depth",
      Buffer.concat([PNG_SIGNATURE, ihdr(1, 1, 3, 2), IDAT, IEND]),
    ],
    [
      "a palette image with no palette",
      Buffer.concat([PNG_SIGNATURE, ihdr(1, 1, 8, 3), IDAT, IEND]),
    ],
    [
      "two palettes",
      Buffer.concat([
        PNG_SIGNATURE,
        ihdr(1, 1, 8, 3),
        pngChunk("PLTE", Buffer.alloc(3)),
        pngChunk("PLTE", Buffer.alloc(3)),
        IDAT,
        IEND,
      ]),
    ],
    [
      "a palette after the data",
      Buffer.concat([
        PNG_SIGNATURE,
        ihdr(),
        IDAT,
        pngChunk("PLTE", Buffer.alloc(3)),
        IEND,
      ]),
    ],
    [
      "data in the end chunk",
      Buffer.concat([PNG_SIGNATURE, ihdr(), IDAT, pngChunk("IEND", secret)]),
    ],
    [
      "a short header",
      Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("IHDR", Buffer.alloc(4)),
        IDAT,
        IEND,
      ]),
    ],
  ])("refuses %s", (_name, file) => {
    expect(cleanLogo(file)).toEqual(NOT_AN_IMAGE);
  });
});

describe("logo checks: JPEG (#227)", () => {
  it("removes EXIF, XMP, ICC, Adobe and comment segments", () => {
    const plain = jpeg({ width: 20, height: 10 });
    const tagged = jpeg(
      { width: 20, height: 10 },
      jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), secret])),
      jpegSegment(0xe2, secret),
      jpegSegment(0xed, secret),
      jpegSegment(0xee, secret),
      jpegSegment(0xef, secret),
      jpegSegment(0xfe, secret),
    );
    const result = cleanLogo(tagged);
    expect(result).toMatchObject({ type: "image/jpeg", width: 20, height: 10 });
    if ("refused" in result) throw new Error("refused");
    expect(latin1(result.bytes)).not.toContain(SECRET);
    expect(Buffer.from(result.bytes).equals(plain)).toBe(true);
  });

  it("removes an APP0 segment that isn't the JFIF header", () => {
    const result = cleanLogo(jpeg({}, jpegSegment(0xe0, secret)));
    if ("refused" in result) throw new Error("refused");
    expect(latin1(result.bytes)).not.toContain(SECRET);
    expect(latin1(result.bytes)).toContain("JFIF");
  });

  it("reads a progressive image with several scans and skips fill bytes", () => {
    const progressive = jpegSegment(
      0xc2,
      Buffer.from([8, 0, 7, 0, 5, 1, 1, 0x11, 0]),
    );
    const file = Buffer.concat([
      SOI,
      Buffer.from([0xff]),
      QUANT,
      progressive,
      SCAN,
      SCAN,
      Buffer.from([0xff, 0xff, 0x00]),
      EOI,
    ]);
    expect(cleanLogo(file)).toMatchObject({ width: 5, height: 7 });
  });

  it.each([
    ["too wide", MAX_LOGO_SIDE + 1, 1],
    ["too tall", 1, MAX_LOGO_SIDE + 1],
    ["a decompression bomb", 65_535, 65_535],
    ["zero tall", 1, 0],
  ])("refuses %s", (_name, width, height) => {
    expect(cleanLogo(jpeg({ width, height }))).toEqual(TOO_BIG);
  });

  const parts = [QUANT, sof(), HUFFMAN, SCAN, EOI];
  it.each<[string, Buffer]>([
    [
      "data after the image ends",
      Buffer.concat([jpeg(), Buffer.from("<script>")]),
    ],
    [
      "a zip after the image ends",
      Buffer.concat([jpeg(), Buffer.from("PK\x03\x04")]),
    ],
    ["only the first three bytes", Buffer.from([0xff, 0xd8, 0xff])],
    ["no scan", Buffer.concat([SOI, QUANT, sof(), EOI])],
    ["a scan before the frame", Buffer.concat([SOI, SCAN, EOI])],
    ["two frames", Buffer.concat([SOI, sof(), sof(9, 9), SCAN, EOI])],
    [
      "a short frame",
      Buffer.concat([SOI, jpegSegment(0xc0, Buffer.alloc(2)), SCAN, EOI]),
    ],
    ["a scan that never ends", Buffer.concat([SOI, sof(), SCAN])],
    ["no end marker", Buffer.concat([SOI, QUANT, sof()])],
    [
      "junk between segments",
      Buffer.concat([SOI, Buffer.from("html"), ...parts]),
    ],
    [
      "a segment longer than the file",
      Buffer.concat([SOI, Buffer.from([0xff, 0xdb, 0xff, 0xff])]),
    ],
    [
      "a segment with an impossible length",
      Buffer.concat([SOI, Buffer.from([0xff, 0xdb, 0x00, 0x01]), ...parts]),
    ],
    [
      "a cut-off segment header",
      Buffer.concat([SOI, Buffer.from([0xff, 0xdb, 0x00])]),
    ],
    [
      "an unknown segment",
      Buffer.concat([SOI, jpegSegment(0xf0, secret), ...parts]),
    ],
    ["a second start marker", Buffer.concat([SOI, SOI, ...parts])],
  ])("refuses %s", (_name, file) => {
    expect(cleanLogo(file)).toEqual(NOT_AN_IMAGE);
  });
});

describe("logo checks: other files (#227)", () => {
  it.each<[string, string]>([
    ["SVG", '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
    ["a renamed HTML file", "<!DOCTYPE html><script>alert(1)</script>"],
    ["PDF", "%PDF-1.7"],
    ["GIF", "GIF89a"],
    ["an empty file", ""],
  ])("refuses %s", (_name, text) => {
    expect(cleanLogo(Buffer.from(text))).toEqual(NOT_AN_IMAGE);
  });

  it("checks a view into a larger buffer, not the whole buffer", () => {
    const file = png();
    const padded = Buffer.concat([Buffer.alloc(5), file, Buffer.alloc(5)]);
    const view = new Uint8Array(
      padded.buffer,
      padded.byteOffset + 5,
      file.length,
    );
    expect(cleanLogo(view)).toMatchObject({ type: "image/png" });
  });
});
