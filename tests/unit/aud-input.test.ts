import { describe, expect, it } from "vitest";
import {
  audInput,
  parseAudInput,
  percentToBasisPoints,
} from "../../apps/web/src/lib/aud-input";
describe("AUD form boundary", () => {
  it("converts decimal text to exact cents without floating-point amounts", () => {
    expect(parseAudInput("2500.01")).toBe("250001");
    expect(parseAudInput("0.29")).toBe("29");
    expect(parseAudInput(".5")).toBe("50");
    expect(parseAudInput("10000000000.00")).toBe("1000000000000");
    expect(audInput("1000000000000")).toBe("10000000000.00");
    expect(audInput("29")).toBe("0.29");
    expect(parseAudInput(" ")).toBeNull();
    expect(audInput(null)).toBe("");
  });
  it("rejects negative, fractional-cent, exponential and oversized inputs", () => {
    for (const value of [
      "-1",
      "1.001",
      "1e3",
      "Infinity",
      "$1",
      "1,000",
      "10000000000.01",
    ])
      expect(() => parseAudInput(value), value).toThrow(RangeError);
  });
});

describe("percentToBasisPoints (#139)", () => {
  it("converts 0–100% with up to two decimals without floating point", () => {
    const cases: [string, number | null][] = [
      ["0", 0],
      ["5", 500],
      ["0.01", 1],
      ["50.5", 5050],
      ["99.99", 9999],
      ["100", 10_000],
      [" 100.00 ", 10_000],
      ["", null],
      ["-1", null],
      ["100.01", null],
      ["101", null],
      ["05", null],
      [".5", null],
      ["50.", null],
      ["50%", null],
      ["1e2", null],
    ];
    for (const [input, expected] of cases)
      expect(percentToBasisPoints(input), input).toBe(expected);
  });
});
