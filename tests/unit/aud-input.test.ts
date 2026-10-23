import { describe, expect, it } from "vitest";
import { audInput, parseAudInput } from "../../apps/web/src/lib/aud-input";
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
